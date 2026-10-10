/**
 * Outbound attachment preparation — pure, no MCP or SMTP dependency.
 *
 * Stats every file BEFORE anything is read into memory, and enforces the
 * configured cap against the base64-ENCODED size (raw × 4/3), because that is
 * what the SMTP server actually receives; a 20 MB file inside a 25 MB limit
 * still bounces as ~27 MB on the wire. Rejections list every file with its
 * size so the caller can see exactly what to trim instead of decoding an
 * opaque SMTP 552 later.
 */

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

/** An attachment request: a bare path, or a path with inline/cid metadata. */
export interface AttachmentInput {
  path: string;
  /** Override the filename shown to the recipient (default: basename). */
  filename?: string;
  /** Content-ID — the HTML body references the file as src="cid:<cid>". */
  cid?: string;
  /** Explicit MIME type when the extension would misdetect. */
  contentType?: string;
}

export interface PreparedAttachment {
  filename: string;
  path: string;
  size: number;
  cid?: string;
  contentType?: string;
}

export interface PreparedAttachments {
  attachments: PreparedAttachment[];
  totalBytes: number;
  totalEncodedBytes: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function prepareAttachments(
  paths: (string | AttachmentInput)[],
  maxTotalMb: number,
): Promise<PreparedAttachments> {
  const attachments: PreparedAttachment[] = [];

  for (const entry of paths) {
    const spec = typeof entry === 'string' ? { path: entry } : entry;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(spec.path);
    } catch {
      throw new Error(`Attachment not found: ${spec.path}`);
    }
    if (!info.isFile()) {
      throw new Error(`Attachment is not a file: ${spec.path}`);
    }
    attachments.push({
      filename: spec.filename ?? basename(spec.path),
      path: spec.path,
      size: info.size,
      ...(spec.cid ? { cid: spec.cid } : {}),
      ...(spec.contentType ? { contentType: spec.contentType } : {}),
    });
  }

  const totalBytes = attachments.reduce((sum, a) => sum + a.size, 0);
  const totalEncodedBytes = Math.ceil(totalBytes / 3) * 4; // base64 wire size

  const maxBytes = maxTotalMb * 1024 * 1024;
  if (totalEncodedBytes > maxBytes) {
    const table = attachments.map((a) => `  - ${a.filename}: ${formatSize(a.size)}`).join('\n');
    throw new Error(
      `Attachments exceed the ${maxTotalMb} MB send limit: ` +
        `${formatSize(totalBytes)} raw ≈ ${formatSize(totalEncodedBytes)} base64-encoded.\n${table}\n` +
        `Raise [settings.send] max_attachment_mb (or MCP_EMAIL_SEND_MAX_ATTACHMENT_MB in env mode) if the provider allows more.`,
    );
  }

  return { attachments, totalBytes, totalEncodedBytes };
}
