/**
 * MIME structure walking — pure helpers over ImapFlow's bodyStructure.
 *
 * No IMAP connection, no MCP dependency — fully unit-testable with plain
 * fixture objects. Moved verbatim from imap.service.ts so body-part selection
 * and attachment discovery can be tested without a client.
 */

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

export function extractAttachments(bodyStructure: unknown): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  if (!bodyStructure || typeof bodyStructure !== 'object') return attachments;

  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    attachments.push({
      filename: params.filename ?? params.name ?? 'unnamed',
      // `bs.type` is already a complete Content-Type; there is no subtype
      // field to append.
      mimeType: typeof bs.type === 'string' ? bs.type.toLowerCase() : 'application/octet-stream',
      size: (bs.size as number) ?? 0,
    });
  }

  if (Array.isArray(bs.childNodes)) {
    (bs.childNodes as unknown[]).forEach((child) => {
      attachments.push(...extractAttachments(child));
    });
  }

  return attachments;
}

/** Find the MIME part number for an attachment by filename. */
export function findMimePartByFilename(
  bodyStructure: unknown,
  targetFilename: string,
  partPath = '',
): string | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') return undefined;

  const bs = bodyStructure as Record<string, unknown>;
  const currentPart = bs.part as string | undefined;
  const effectivePath = currentPart ?? partPath;

  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    const filename = params.filename ?? params.name ?? 'unnamed';
    if (filename === targetFilename) return effectivePath;
  }

  if (Array.isArray(bs.childNodes)) {
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < bs.childNodes.length; i++) {
      const childPart = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      const found = findMimePartByFilename(bs.childNodes[i], targetFilename, childPart);
      if (found) return found;
    }
  }

  return undefined;
}

/** A displayable (non-attachment) text part discovered in the MIME tree. */
export interface TextPart {
  /** IMAP part path, e.g. "1.1" */
  path: string;
  /** Content subtype: "plain" | "html" | … (derived from the full MIME type) */
  subtype: string;
  size: number;
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

/**
 * Collect every non-attachment text/* part in the MIME tree, in document order.
 *
 * Mirrors the traversal in `findMimePartByFilename` — part paths come from
 * `bs.part` when the server supplies one, otherwise from the 1-based child
 * index chain.
 */
export function collectTextParts(bodyStructure: unknown, partPath = ''): TextPart[] {
  if (!bodyStructure || typeof bodyStructure !== 'object') return [];

  const bs = bodyStructure as Record<string, unknown>;
  const effectivePath = (bs.part as string | undefined) ?? partPath;
  const found: TextPart[] = [];

  if (Array.isArray(bs.childNodes)) {
    bs.childNodes.forEach((child, i) => {
      const childPath = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      found.push(...collectTextParts(child, childPath));
    });
    return found;
  }

  // Leaf node. Attachments are never body content, even when text/*.
  const { type, subtype } = splitMimeType(bs.type);
  if (type === 'text' && bs.disposition !== 'attachment') {
    found.push({
      // A single-part message has no `part` field at all — the body is
      // addressable as part "1", which is what the vast majority of real mail
      // looks like. Without this the caller falls back to raw `source`, which
      // is still transfer-encoded.
      path: effectivePath || '1',
      subtype,
      size: typeof bs.size === 'number' ? bs.size : 0,
    });
  }

  return found;
}

/**
 * Choose which text part to download for an email's body, or `undefined` to
 * skip the extra round trip and use the body already parsed from `source`.
 *
 * `parts` is in document order and excludes attachments.
 *
 * Prefers `text/plain`: it is far cheaper in agent context-window terms, which
 * `docs/performance-roadmap.md` identifies as the real constraint.
 *
 * The exception is the stub plain part — a few dozen bytes of "This message
 * requires an HTML-capable reader" shipped next to the real content in HTML.
 * Taking it literally makes the model report the placeholder as the email, so
 * an implausibly small plain part loses to a much larger HTML sibling.
 */
const STUB_PLAIN_MAX_BYTES = 200;
const STUB_PLAIN_RATIO = 5;

export function selectBodyPart(parts: TextPart[]): TextPart | undefined {
  const plain = parts.find((p) => p.subtype === 'plain');
  const html = parts.find((p) => p.subtype === 'html');

  if (!plain) return html ?? parts[0];
  if (html && plain.size < STUB_PLAIN_MAX_BYTES && html.size > plain.size * STUB_PLAIN_RATIO) {
    return html;
  }
  return plain;
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

  return headers;
}
