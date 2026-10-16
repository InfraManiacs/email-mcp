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
  it('extracts filename, lowercased mime type, size, and part id', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        textPlain(),
        {
          type: 'Application/PDF',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
          size: 1234,
          encoding: 'base64',
        },
      ],
    };
    expect(extractAttachments(bs)).toEqual([
      {
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 1234,
        partId: '2',
        encoding: 'base64',
      },
    ]);
  });

  it('falls back to parameters.name, then "unnamed", and size 0', () => {
    const named = { type: 'image/png', disposition: 'attachment', parameters: { name: 'x.png' } };
    const bare = { type: 'image/png', disposition: 'attachment' };
    expect(extractAttachments(named)[0]).toMatchObject({
      filename: 'x.png',
      mimeType: 'image/png',
      size: 0,
    });
    expect(extractAttachments(bare)[0]?.filename).toBe('unnamed');
  });

  it('lists an inline image with its content id', () => {
    // Inline cid parts are real content shipped with the message; hiding them
    // made <img src="cid:..."> references undownloadable.
    const bs = {
      type: 'multipart/related',
      childNodes: [
        textHtml(),
        {
          type: 'image/png',
          disposition: 'inline',
          id: '<logo@x>',
          parameters: { name: 'logo.png' },
          size: 900,
        },
      ],
    };
    expect(extractAttachments(bs)).toEqual([
      {
        filename: 'logo.png',
        mimeType: 'image/png',
        size: 900,
        partId: '2',
        contentId: 'logo@x',
        inline: true,
      },
    ]);
  });

  it('lists a non-text part named only via Content-Type name=', () => {
    // Older mailers ship attachments with no Content-Disposition at all.
    const bs = {
      type: 'multipart/mixed',
      childNodes: [textPlain(), { type: 'application/pdf', parameters: { name: 'x.pdf' } }],
    };
    expect(extractAttachments(bs).map((a) => a.filename)).toEqual(['x.pdf']);
  });

  it('does not list inline or undispositioned text parts (they are the body)', () => {
    const bs = {
      type: 'multipart/alternative',
      childNodes: [textPlain(400, { disposition: 'inline' }), textHtml()],
    };
    expect(extractAttachments(bs)).toEqual([]);
  });

  it('gives duplicate filenames distinct part ids', () => {
    const invoice = {
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'invoice.pdf' },
    };
    const bs = { type: 'multipart/mixed', childNodes: [textPlain(), invoice, { ...invoice }] };
    const ids = extractAttachments(bs).map((a) => a.partId);
    expect(ids).toEqual(['2', '3']);
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

  it('records format=flowed and DelSp so the body can be unwrapped', () => {
    const parts = collectTextParts(
      textPlain(100, { parameters: { charset: 'utf-8', format: 'Flowed', delsp: 'Yes' } }),
    );
    expect(parts[0]?.flowed).toBe(true);
    expect(parts[0]?.delSp).toBe(true);
  });

  it('leaves a fixed-format part unflagged', () => {
    const parts = collectTextParts(textPlain(100, { parameters: { charset: 'utf-8' } }));
    expect(parts[0]?.flowed).toBeUndefined();
    expect(parts[0]?.delSp).toBeUndefined();
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

  it('falls back to encapsulated text when the message has no body of its own', () => {
    // "Forward as attachment" with no covering note, and mailing-list
    // digests, carry their only readable text inside message/rfc822 parts.
    // Excluding those unconditionally left the reader with "(no content)".
    const forwardedOnly = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'message/rfc822', disposition: 'attachment', childNodes: [textPlain(300)] },
      ],
    };
    expect(collectTextParts(forwardedOnly).map((p) => p.path)).toEqual(['1.1']);

    const digest = {
      type: 'multipart/digest',
      childNodes: [
        { type: 'message/rfc822', childNodes: [textPlain(200)] },
        { type: 'message/rfc822', childNodes: [textPlain(250)] },
      ],
    };
    expect(collectTextParts(digest).map((p) => p.path)).toEqual(['1.1', '2.1']);
  });

  it("still prefers the message's own body over encapsulated text", () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        textHtml(),
        { type: 'message/rfc822', disposition: 'attachment', childNodes: [textPlain(300)] },
      ],
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
    expect(plain.map((p) => p.path)).toEqual(['1']);
    expect(html.map((p) => p.path)).toEqual(['2']);
  });

  // multipart/mixed splits running text across siblings: Apple Mail puts a
  // note either side of an inline photo, and a digest carries one part per
  // message. Representing the group by its first part drops the rest.
  it('returns every sibling plain part, so text around an inline image survives', () => {
    const parts = collectTextParts({
      type: 'multipart/mixed',
      childNodes: [
        textPlain(40),
        { type: 'image/jpeg', size: 90_000, disposition: 'inline', parameters: { name: 'p.jpg' } },
        textPlain(120),
      ],
    });
    expect(selectBodyParts(parts).plain.map((p) => p.path)).toEqual(['1', '3']);
  });

  it('returns every sibling html part', () => {
    const parts = collectTextParts({
      type: 'multipart/mixed',
      childNodes: [textHtml(900), textHtml(1200)],
    });
    expect(selectBodyParts(parts).html.map((p) => p.path)).toEqual(['1', '2']);
  });

  it('suppresses a stub plain part (<200 bytes next to >5x HTML) instead of returning it', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(80), textHtml(5000)],
      }),
    );
    expect(plain).toEqual([]);
    expect(html[0]?.subtype).toBe('html');
  });

  // A chattier placeholder — one that adds an unsubscribe line — clears the
  // 200-byte floor, but a 200x HTML sibling cannot hold the same content.
  it('suppresses an over-long stub that the HTML sibling dwarfs', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(250), textHtml(50_000)],
      }),
    );
    expect(plain).toEqual([]);
    expect(html[0]?.subtype).toBe('html');
  });

  it('keeps a small plain part when the HTML sibling is not 5x larger', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(80), textHtml(300)],
      }),
    );
    expect(plain[0]?.subtype).toBe('plain');
    expect(html[0]?.subtype).toBe('html');
  });

  it('keeps a genuinely short note whose HTML twin is merely styled', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(500), textHtml(3000)],
      }),
    );
    expect(plain[0]?.subtype).toBe('plain');
    expect(html[0]?.subtype).toBe('html');
  });

  it('weighs the stub heuristic on the whole group, not the first part', () => {
    const { plain } = selectBodyParts(
      collectTextParts({
        type: 'multipart/mixed',
        childNodes: [textPlain(60), textPlain(900), textHtml(4000)],
      }),
    );
    expect(plain.map((p) => p.size)).toEqual([60, 900]);
  });

  // Transfer cost outranks the stub rule: the over-cap stream is drained in
  // full, so fetching 10 MB of HTML to keep 512 KB is the worse trade even
  // against a plain part too small to hold the same content.
  it('keeps a small plain part over an over-cap html sibling, outranking the stub rule', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(400), textHtml(10 * 1024 * 1024)],
      }),
      512 * 1024,
    );
    expect(plain.map((p) => p.size)).toEqual([400]);
    expect(html).toEqual([]);
  });

  it('drops an over-cap plain group for a within-cap html sibling', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(2 * 1024 * 1024), textHtml(9000)],
      }),
      512 * 1024,
    );
    expect(plain).toEqual([]);
    expect(html.map((p) => p.size)).toEqual([9000]);
  });

  it('prefers plain when both groups are over the cap', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/alternative',
        childNodes: [textPlain(2 * 1024 * 1024), textHtml(8 * 1024 * 1024)],
      }),
      512 * 1024,
    );
    expect(plain.map((p) => p.size)).toEqual([2 * 1024 * 1024]);
    expect(html).toEqual([]);
  });

  it('sums a group against the cap, since every part in it is downloaded', () => {
    const { plain, html } = selectBodyParts(
      collectTextParts({
        type: 'multipart/mixed',
        childNodes: [textPlain(400 * 1024), textPlain(400 * 1024), textHtml(9000)],
      }),
      512 * 1024,
    );
    expect(plain).toEqual([]);
    expect(html.map((p) => p.size)).toEqual([9000]);
  });

  it('slots a lone non-plain/html text part as the plain body', () => {
    const { plain, html } = selectBodyParts([{ path: '1', subtype: 'enriched', size: 10 }]);
    expect(plain[0]?.subtype).toBe('enriched');
    expect(html).toEqual([]);
  });

  it('returns nothing for an empty part list', () => {
    expect(selectBodyParts([])).toEqual({ plain: [], html: [] });
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

  it('decodes RFC 2047 encoded words', () => {
    const raw = Buffer.from(
      'Subject: =?UTF-8?B?w6TDtsO8?=\r\nX-Note: =?ISO-8859-1?Q?Gr=FC=DFe?=\r\n\r\n',
      'utf-8',
    );
    const headers = parseHeaders(raw);
    expect(headers.subject).toBe('äöü');
    expect(headers['x-note']).toBe('Grüße');
  });

  it('decodes an encoded word split across a folded line', () => {
    // RFC 2047 allows one logical word to span continuation lines; decoding
    // must happen after unfolding or each half decodes separately.
    const raw = Buffer.from('Subject: =?UTF-8?B?w6TDtg==?=\r\n =?UTF-8?B?w7w=?=\r\n\r\n', 'utf-8');
    expect(parseHeaders(raw).subject).toBe('äöü');
  });
});
