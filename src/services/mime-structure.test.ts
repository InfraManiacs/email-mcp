import {
  collectTextParts,
  describeUndisplayableStructure,
  extractAttachments,
  findDeliveryStatusPart,
  findMimePartByFilename,
  hasAttachments,
  parseHeaders,
  selectBodyParts,
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

  it('excludes text parts inside an attached message/rfc822', () => {
    // An attached .eml's inner text is the attachment's content, not this
    // message's body — the exclusion must apply to the whole subtree, not
    // just the leaf's own disposition.
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
    expect(collectTextParts(bs).map((p) => p.path)).toEqual(['1']);
  });

  it('excludes text inside an embedded message even without a disposition', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [textHtml(), { type: 'message/rfc822', childNodes: [textPlain(300)] }],
    };
    expect(collectTextParts(bs).map((p) => p.path)).toEqual(['1']);
  });
});

describe('selectBodyParts', () => {
  it('returns both halves of multipart/alternative', () => {
    const parts = collectTextParts({
      type: 'multipart/alternative',
      childNodes: [textPlain(), textHtml()],
    });
    const { plain, html } = selectBodyParts(parts);
    expect(plain?.path).toBe('1');
    expect(html?.path).toBe('2');
  });

  it('suppresses a stub plain part (<200 bytes next to >5x HTML) instead of returning it', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(80), textHtml(5000)],
      }),
    );
    expect(plain).toBeUndefined();
    expect(html?.subtype).toBe('html');
  });

  it('keeps a small plain part when the HTML sibling is not 5x larger', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(80), textHtml(300)],
      }),
    );
    expect(plain?.subtype).toBe('plain');
    expect(html?.subtype).toBe('html');
  });

  it('slots a lone non-plain/html text part as the plain body', () => {
    const { plain, html } = selectBodyParts([{ path: '1', subtype: 'enriched', size: 10 }]);
    expect(plain?.subtype).toBe('enriched');
    expect(html).toBeUndefined();
  });

  it('returns nothing for an empty part list', () => {
    expect(selectBodyParts([])).toEqual({});
  });
});

describe('describeUndisplayableStructure', () => {
  it('labels S/MIME messages', () => {
    const label = describeUndisplayableStructure({ type: 'application/pkcs7-mime', size: 4000 });
    expect(label).toMatch(/S\/MIME/);
  });

  it('labels PGP/MIME encrypted messages', () => {
    const bs = {
      type: 'multipart/encrypted',
      childNodes: [
        { type: 'application/pgp-encrypted', size: 10 },
        { type: 'application/octet-stream', size: 5000 },
      ],
    };
    expect(describeUndisplayableStructure(bs)).toMatch(/PGP/);
  });

  it('returns undefined for ordinary structures', () => {
    expect(describeUndisplayableStructure(textHtml())).toBeUndefined();
  });
});

describe('findDeliveryStatusPart', () => {
  it('locates the machine-readable part of a bounce report', () => {
    const bs = {
      type: 'multipart/report',
      childNodes: [
        textPlain(400),
        { type: 'message/delivery-status', size: 300 },
        { type: 'message/rfc822', childNodes: [textPlain(100)] },
      ],
    };
    expect(findDeliveryStatusPart(bs)).toBe('2');
  });

  it('returns undefined when there is no delivery-status part', () => {
    expect(findDeliveryStatusPart(textPlain())).toBeUndefined();
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
