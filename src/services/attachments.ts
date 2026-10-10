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

export interface PreparedAttachment {
  filename: string;
  path: string;
  size: number;
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
  paths: string[],
  maxTotalMb: number,
): Promise<PreparedAttachments> {
  const attachments: PreparedAttachment[] = [];

  for (const path of paths) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`Attachment not found: ${path}`);
    }
    if (!info.isFile()) {
      throw new Error(`Attachment is not a file: ${path}`);
    }
    attachments.push({ filename: basename(path), path, size: info.size });
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
