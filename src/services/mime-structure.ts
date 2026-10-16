/**
 * MIME structure walking — pure helpers over ImapFlow's bodyStructure.
 *
 * No IMAP connection, no MCP dependency — fully unit-testable with plain
 * fixture objects. Moved verbatim from imap.service.ts so body-part selection
 * and attachment discovery can be tested without a client.
 */

import libmime from 'libmime';
import type { AttachmentMeta } from '../types/index.js';

export function hasAttachments(bodyStructure: unknown): boolean {
  if (!bodyStructure || typeof bodyStructure !== 'object') return false;
  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') return true;
  if (Array.isArray(bs.childNodes)) {
    return bs.childNodes.some((child: unknown) => hasAttachments(child));
  }
  return false;
}

function walkAttachments(bodyStructure: unknown, partPath: string): AttachmentMeta[] {
  if (!bodyStructure || typeof bodyStructure !== 'object') return [];

  const bs = bodyStructure as Record<string, unknown>;
  const effectivePath = (bs.part as string | undefined) ?? partPath;
  const { type } = splitMimeType(bs.type);
  const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
  const name = params.filename ?? params.name;
  const rawId = typeof bs.id === 'string' ? bs.id : undefined;
  const contentId = rawId?.replace(/^</, '').replace(/>$/, '');
  const isContainer = Array.isArray(bs.childNodes);

  const isAttachment = bs.disposition === 'attachment';
  // Inline non-text parts are the cid images the HTML references — without a
  // listing they are invisible and undownloadable. Text parts stay out: an
  // inline text part is the body.
  const isInline =
    bs.disposition === 'inline' &&
    !isContainer &&
    type !== 'text' &&
    (name !== undefined || contentId !== undefined);
  // Older mailers ship attachments with no Content-Disposition at all, named
  // only by Content-Type's name= parameter.
  const isBareNamed =
    bs.disposition === undefined &&
    !isContainer &&
    type !== 'text' &&
    type !== 'multipart' &&
    name !== undefined;

  const found: AttachmentMeta[] = [];
  if (isAttachment || isInline || isBareNamed) {
    found.push({
      filename: name ?? 'unnamed',
      // `bs.type` is already a complete Content-Type; there is no subtype
      // field to append.
      mimeType: typeof bs.type === 'string' ? bs.type.toLowerCase() : 'application/octet-stream',
      size: (bs.size as number) ?? 0,
      partId: effectivePath || '1',
      ...(typeof bs.encoding === 'string' ? { encoding: bs.encoding } : {}),
      ...(contentId ? { contentId } : {}),
      ...(isInline ? { inline: true } : {}),
    });
  }

  if (isContainer) {
    (bs.childNodes as unknown[]).forEach((child, i) => {
      const childPath = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      found.push(...walkAttachments(child, childPath));
    });
  }

  return found;
}

export function extractAttachments(bodyStructure: unknown): AttachmentMeta[] {
  return walkAttachments(bodyStructure, '');
}

/**
 * Find the MIME part id for an attachment by filename.
 *
 * Delegates to the same walk `extractAttachments` uses rather than its own
 * narrower one: a part listed there — a classic attachment, an inline cid
 * image, or one named only via Content-Type's name= — must be the same part
 * this can find, or a filename the listing showed becomes undownloadable by
 * it. Duplicate filenames resolve to the first match in document order; use
 * the part id from the listing to reach the others.
 */
export function findMimePartByFilename(
  bodyStructure: unknown,
  targetFilename: string,
): string | undefined {
  return extractAttachments(bodyStructure).find((a) => a.filename === targetFilename)?.partId;
}

/** A displayable (non-attachment) text part discovered in the MIME tree. */
export interface TextPart {
  /** IMAP part path, e.g. "1.1" */
  path: string;
  /** Content subtype: "plain" | "html" | … (derived from the full MIME type) */
  subtype: string;
  size: number;
  /** Content-Type carried `format=flowed`: soft line wraps need undoing. */
  flowed?: boolean;
  /** `format=flowed` with `DelSp=yes`: the space marking a wrap is not content. */
  delSp?: boolean;
}

/**
 * Split an ImapFlow structure node's Content-Type.
 *
 * ImapFlow reports `type` as the complete Content-Type ("text/html") and has
 * no `subtype` field at all — see MessageStructureObject in imap-flow.d.ts.
 */
export function splitMimeType(type: unknown): { type: string; subtype: string } {
  const full = typeof type === 'string' ? type.toLowerCase() : '';
  const slash = full.indexOf('/');
  if (slash < 0) return { type: full, subtype: '' };
  return { type: full.slice(0, slash), subtype: full.slice(slash + 1) };
}

function walkTextParts(
  bodyStructure: unknown,
  partPath: string,
  excluded: boolean,
  isRoot: boolean,
  allowEncapsulated = false,
): TextPart[] {
  if (!bodyStructure || typeof bodyStructure !== 'object') return [];

  const bs = bodyStructure as Record<string, unknown>;
  const effectivePath = (bs.part as string | undefined) ?? partPath;
  const { type, subtype } = splitMimeType(bs.type);
  const isEncapsulated = !isRoot && type === 'message' && subtype === 'rfc822';

  // An attached subtree is never body content — neither is a message
  // encapsulated inside this one (a forwarded .eml), whose text parts belong
  // to the attachment, not to the message being read. `allowEncapsulated`
  // lifts both exclusions for the fallback pass in collectTextParts, where
  // the encapsulated text is the only text there is.
  const nodeExcluded = allowEncapsulated
    ? excluded
    : excluded || bs.disposition === 'attachment' || isEncapsulated;

  if (Array.isArray(bs.childNodes)) {
    const found: TextPart[] = [];
    bs.childNodes.forEach((child, i) => {
      const childPath = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      found.push(...walkTextParts(child, childPath, nodeExcluded, false, allowEncapsulated));
    });
    return found;
  }

  if (type === 'text' && !nodeExcluded) {
    const params = (bs.parameters ?? {}) as Record<string, unknown>;
    const flowed = typeof params.format === 'string' && params.format.toLowerCase() === 'flowed';
    // DelSp is meaningless without format=flowed, so it only rides along.
    const delSp =
      flowed && typeof params.delsp === 'string' && params.delsp.toLowerCase() === 'yes';
    return [
      {
        // A single-part message has no `part` field at all — the body is
        // addressable as part "1", which is what the vast majority of real
        // mail looks like. Without this the caller falls back to raw
        // `source`, which is still transfer-encoded.
        path: effectivePath || '1',
        subtype,
        size: typeof bs.size === 'number' ? bs.size : 0,
        ...(flowed ? { flowed: true } : {}),
        ...(delSp ? { delSp: true } : {}),
      },
    ];
  }

  return [];
}

/**
 * Collect every displayable text/* part in the MIME tree, in document order.
 *
 * Excludes attachments — including everything nested under one — and the
 * contents of embedded message/rfc822 parts. Part paths come from `bs.part`
 * when the server supplies one, otherwise from the 1-based child index chain
 * (mirroring the traversal in `findMimePartByFilename`).
 *
 * A message whose only text lives inside encapsulated messages — "forward as
 * attachment" with no covering note, or a mailing-list digest — is retried
 * with that exclusion lifted, since otherwise there is no body to show at all.
 */
export function collectTextParts(bodyStructure: unknown, partPath = ''): TextPart[] {
  const own = walkTextParts(bodyStructure, partPath, false, true);
  if (own.length > 0) return own;
  return walkTextParts(bodyStructure, partPath, false, true, true);
}

/**
 * A plain part this small next to a much larger HTML sibling is the "This
 * message requires an HTML-capable reader" placeholder, not the content.
 */
const STUB_PLAIN_MAX_BYTES = 200;
const STUB_PLAIN_RATIO = 5;
/**
 * A chattier placeholder — one that appends an unsubscribe line — clears the
 * floor above, so a second tier catches the ones their HTML sibling dwarfs.
 * Suppressing a plain side is cheap when it happens to be real: the HTML
 * carries the same content, and stripHtml renders it.
 */
const STUB_PLAIN_OUTLIER_MAX_BYTES = 2_000;
const STUB_PLAIN_OUTLIER_RATIO = 20;

function totalSize(parts: TextPart[]): number {
  return parts.reduce((sum, part) => sum + part.size, 0);
}

/** Weighed across the whole group, since every part in it is downloaded. */
function isStubPlain(plainBytes: number, htmlBytes: number): boolean {
  return (
    (plainBytes < STUB_PLAIN_MAX_BYTES && htmlBytes > plainBytes * STUB_PLAIN_RATIO) ||
    (plainBytes < STUB_PLAIN_OUTLIER_MAX_BYTES && htmlBytes > plainBytes * STUB_PLAIN_OUTLIER_RATIO)
  );
}

/**
 * Choose which text parts to download for an email's body.
 *
 * `parts` is in document order and excludes attachments. Both halves of a
 * multipart/alternative are returned so bodyText and bodyHtml can coexist —
 * magic-link extraction and calendar scanning each want a specific side — and
 * every sibling of one subtype comes back together, because multipart/mixed
 * splits running text across several: Apple Mail puts a note either side of an
 * inline photo, and a digest carries one part per message. Keeping only the
 * first silently truncates the body.
 *
 * `maxBytes` caps a group's combined size. Two rules can drop a side, and the
 * order matters: transfer cost is settled first, because an over-cap stream is
 * drained in full, so pulling 10 MB of HTML to keep 512 KB of it loses even to
 * a plain part too small to hold the same content. Only among groups that both
 * fit does the stub rule then suppress a placeholder plain side.
 */
export function selectBodyParts(
  parts: TextPart[],
  maxBytes = Number.POSITIVE_INFINITY,
): { plain: TextPart[]; html: TextPart[] } {
  const plain = parts.filter((p) => p.subtype === 'plain');
  const html = parts.filter((p) => p.subtype === 'html');

  if (plain.length === 0 && html.length === 0) {
    // A lone text part of another subtype (text/enriched, text/x-amp-html…)
    // is still the closest thing to a readable body.
    const first = parts[0];
    if (!first) return { plain: [], html: [] };
    return first.subtype === 'html' ? { plain: [], html: [first] } : { plain: [first], html: [] };
  }

  if (plain.length > 0 && html.length > 0) {
    const plainBytes = totalSize(plain);
    const htmlBytes = totalSize(html);

    // Prefer plain when neither side fits: it is cheaper in context-window
    // terms and already readable.
    if (plainBytes > maxBytes) {
      return htmlBytes <= maxBytes ? { plain: [], html } : { plain, html: [] };
    }
    if (htmlBytes > maxBytes) return { plain, html: [] };
    if (isStubPlain(plainBytes, htmlBytes)) return { plain: [], html };
  }

  return { plain, html };
}

/**
 * Explain a structure that yields no displayable text part, instead of the
 * bare "(no content)" the tool layer would otherwise show. Encrypted payloads
 * are not parsed — the label tells the model (and the user) what it is
 * looking at and what to do about it.
 */
export function describeUndisplayableStructure(bodyStructure: unknown): string | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') return undefined;
  const bs = bodyStructure as Record<string, unknown>;
  const { type, subtype } = splitMimeType(bs.type);

  if (type === 'application' && (subtype === 'pkcs7-mime' || subtype === 'x-pkcs7-mime')) {
    return (
      '(S/MIME encrypted or signed message — content is not displayable here; ' +
      'download the smime.p7m attachment to process it externally)'
    );
  }
  if (type === 'multipart' && subtype === 'encrypted') {
    return '(PGP/MIME encrypted message — the payload is encrypted and not readable here)';
  }
  return undefined;
}

/**
 * Find the machine-readable part of a bounce (multipart/report). Its
 * message/delivery-status part is plain key-value text carrying the Action,
 * Status, and Diagnostic-Code fields that say what actually failed.
 */
export function findDeliveryStatusPart(bodyStructure: unknown, partPath = ''): string | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') return undefined;

  const bs = bodyStructure as Record<string, unknown>;
  const effectivePath = (bs.part as string | undefined) ?? partPath;

  if (typeof bs.type === 'string' && bs.type.toLowerCase() === 'message/delivery-status') {
    return effectivePath || '1';
  }

  if (Array.isArray(bs.childNodes)) {
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < bs.childNodes.length; i++) {
      const childPath = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      const found = findDeliveryStatusPart(bs.childNodes[i], childPath);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * Parse an RFC 5322 header block into a lowercase-keyed map.
 *
 * Continuation lines (leading space or tab) are unfolded onto the preceding
 * header, so a long References or Subject split across lines survives intact.
 */
export function parseHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!Buffer.isBuffer(raw)) return headers;

  const text = raw.toString('utf-8');
  const headerEnd = text.indexOf('\r\n\r\n');
  const section = headerEnd >= 0 ? text.slice(0, headerEnd) : text;

  let currentKey: string | undefined;
  section.split(/\r?\n/).forEach((line) => {
    if (/^[ \t]/.test(line)) {
      if (currentKey) headers[currentKey] += ` ${line.trim()}`;
      return;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      currentKey = line.slice(0, colonIdx).trim().toLowerCase();
      headers[currentKey] = line.slice(colonIdx + 1).trim();
    }
  });

  // RFC 2047 decoding runs after unfolding — one encoded word may span
  // continuation lines. decodeWords is a no-op on values without "=?".
  Object.keys(headers).forEach((key) => {
    const value = headers[key];
    if (value?.includes('=?')) {
      try {
        headers[key] = libmime.decodeWords(value);
      } catch {
        // Malformed encoded word — the raw value is still more useful than none.
      }
    }
  });

  return headers;
}
