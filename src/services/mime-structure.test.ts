import {
  collectTextParts,
  extractAttachments,
  findMimePartByFilename,
  hasAttachments,
  parseHeaders,
  selectBodyPart,
  splitMimeType,
} from './mime-structure.js';

// Fixtures mirror ImapFlow's MessageStructureObject shape: `type` is the full
// Content-Type ("text/html"), part paths come from `part` or the 1-based
// child-index chain, and attachments carry `disposition: 'attachment'`.

const textPlain = (size = 500, extra: Record<string, unknown> = {}) => ({
  type: 'text/plain',
  size,
  ...extra,
});
const textHtml = (size = 5000, extra: Record<string, unknown> = {}) => ({
  type: 'text/html',
  size,
  ...extra,
});

describe('splitMimeType', () => {
  it('splits a full Content-Type into lowercased type and subtype', () => {
    expect(splitMimeType('text/HTML')).toEqual({ type: 'text', subtype: 'html' });
  });

  it('returns empty strings for a non-string value', () => {
    expect(splitMimeType(undefined)).toEqual({ type: '', subtype: '' });
  });

  it('returns an empty subtype when there is no slash', () => {
    expect(splitMimeType('multipart')).toEqual({ type: 'multipart', subtype: '' });
  });
});

describe('hasAttachments', () => {
  it('detects a leaf with attachment disposition', () => {
    expect(hasAttachments({ type: 'application/pdf', disposition: 'attachment' })).toBe(true);
  });

  it('detects an attachment nested in childNodes', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [textPlain(), { type: 'application/pdf', disposition: 'attachment' }],
    };
    expect(hasAttachments(bs)).toBe(true);
  });

  it('returns false when no part has attachment disposition', () => {
    const bs = { type: 'multipart/alternative', childNodes: [textPlain(), textHtml()] };
    expect(hasAttachments(bs)).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(hasAttachments(undefined)).toBe(false);
  });
});

describe('extractAttachments', () => {
  it('extracts filename, lowercased mime type, and size', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        textPlain(),
        {
          type: 'Application/PDF',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
          size: 1234,
        },
      ],
    };
    expect(extractAttachments(bs)).toEqual([
      { filename: 'report.pdf', mimeType: 'application/pdf', size: 1234 },
    ]);
  });

  it('falls back to parameters.name, then "unnamed", and size 0', () => {
    const named = { type: 'image/png', disposition: 'attachment', parameters: { name: 'x.png' } };
    const bare = { type: 'image/png', disposition: 'attachment' };
    expect(extractAttachments(named)[0]).toEqual({
      filename: 'x.png',
      mimeType: 'image/png',
      size: 0,
    });
    expect(extractAttachments(bare)[0]?.filename).toBe('unnamed');
  });

  it('ignores inline parts (disposition "inline" is not listed)', () => {
    // Characterization: inline cid images are currently invisible.
    const bs = {
      type: 'multipart/related',
      childNodes: [
        textHtml(),
        { type: 'image/png', disposition: 'inline', parameters: { name: 'logo.png' } },
      ],
    };
    expect(extractAttachments(bs)).toEqual([]);
  });
});

describe('findMimePartByFilename', () => {
  it('finds a nested attachment by the 1-based child-index chain', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        textPlain(),
        { type: 'application/pdf', disposition: 'attachment', parameters: { name: 'a.pdf' } },
      ],
    };
    expect(findMimePartByFilename(bs, 'a.pdf')).toBe('2');
  });

  it('prefers the server-supplied part path when present', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'application/pdf',
          part: '2.1',
          disposition: 'attachment',
          parameters: { name: 'a.pdf' },
        },
      ],
    };
    expect(findMimePartByFilename(bs, 'a.pdf')).toBe('2.1');
  });

  it('returns undefined when no attachment matches', () => {
    expect(findMimePartByFilename(textPlain(), 'a.pdf')).toBeUndefined();
  });
});

describe('collectTextParts', () => {
  it('collects multipart/alternative parts in document order with index paths', () => {
    const bs = { type: 'multipart/alternative', childNodes: [textPlain(), textHtml()] };
    expect(collectTextParts(bs)).toEqual([
      { path: '1', subtype: 'plain', size: 500 },
      { path: '2', subtype: 'html', size: 5000 },
    ]);
  });

  it('addresses a single-part message (no `part` field) as part "1"', () => {
    expect(collectTextParts(textHtml(42))).toEqual([{ path: '1', subtype: 'html', size: 42 }]);
  });

  it('excludes a text leaf with attachment disposition', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [textPlain(), textPlain(10, { disposition: 'attachment' })],
    };
    expect(collectTextParts(bs)).toEqual([{ path: '1', subtype: 'plain', size: 500 }]);
  });

  it('KNOWN BUG: collects text parts inside an attached message/rfc822', () => {
    // An attached .eml's inner text parts become body candidates because only
    // leaf disposition is checked, never an ancestor's. Pinned here; the fix
    // (ancestor exclusion) lands with the dual-body download change.
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        textHtml(),
        {
          type: 'message/rfc822',
          disposition: 'attachment',
          childNodes: [textPlain(300)],
        },
      ],
    };
    const paths = collectTextParts(bs).map((p) => p.path);
    expect(paths).toContain('2.1');
  });
});

describe('selectBodyPart', () => {
  it('prefers text/plain over text/html', () => {
    const parts = collectTextParts({
      type: 'multipart/alternative',
      childNodes: [textPlain(), textHtml()],
    });
    expect(selectBodyPart(parts)?.subtype).toBe('plain');
  });

  it('overrides a stub plain part (<200 bytes) when HTML is >5x larger', () => {
    const parts = collectTextParts({
      type: 'multipart/alternative',
      childNodes: [textPlain(80), textHtml(5000)],
    });
    expect(selectBodyPart(parts)?.subtype).toBe('html');
  });

  it('keeps a small plain part when the HTML sibling is not 5x larger', () => {
    const parts = collectTextParts({
      type: 'multipart/alternative',
      childNodes: [textPlain(80), textHtml(300)],
    });
    expect(selectBodyPart(parts)?.subtype).toBe('plain');
  });

  it('falls back to html, then the first part, then undefined', () => {
    expect(selectBodyPart([{ path: '1', subtype: 'html', size: 10 }])?.subtype).toBe('html');
    expect(selectBodyPart([{ path: '1', subtype: 'enriched', size: 10 }])?.subtype).toBe(
      'enriched',
    );
    expect(selectBodyPart([])).toBeUndefined();
  });
});

describe('parseHeaders', () => {
  it('parses headers into a lowercase-keyed map and unfolds continuations', () => {
    const raw = Buffer.from(
      'Subject: Hello\r\nReferences: <a@x>\r\n <b@x>\r\nX-Custom: v\r\n\r\nbody ignored',
      'utf-8',
    );
    expect(parseHeaders(raw)).toEqual({
      subject: 'Hello',
      references: '<a@x> <b@x>',
      'x-custom': 'v',
    });
  });

  it('returns an empty map for non-buffer input', () => {
    expect(parseHeaders('not a buffer')).toEqual({});
  });

  it('keeps RFC 2047 encoded words raw (characterization: no decoding yet)', () => {
    const raw = Buffer.from('Subject: =?UTF-8?B?w6TDtsO8?=\r\n\r\n', 'utf-8');
    expect(parseHeaders(raw).subject).toBe('=?UTF-8?B?w6TDtsO8?=');
  });
});
