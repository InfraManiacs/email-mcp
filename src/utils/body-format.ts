/**
 * Body formatting shared by every surface that renders an email body —
 * get_email, get_emails, get_thread, and the CLI. One definition so the
 * `format` contract cannot drift between tools (it previously did: three
 * near-duplicates with different HTML handling).
 */

import { stripHtml } from './html.js';
import { stripReplyChain } from './reply-chain.js';

export type BodyFormat = 'full' | 'text' | 'stripped';

/** Default body cap for a single-message fetch (get_email). */
export const DEFAULT_SINGLE_BODY_MAX = 10_000;
/** Default per-message body cap for bulk fetches (get_emails, get_thread). */
export const DEFAULT_MULTI_BODY_MAX = 5_000;

/**
 * Applies the requested body format and optional character cap.
 *
 * - full:     raw bodyText ?? bodyHtml (preserves the original part)
 * - text:     prefers bodyText; converts bodyHtml to readable text if needed
 * - stripped: like text, but also removes quoted reply chains and signatures
 *
 * `maxLength` of 0 (or undefined) means unlimited; otherwise the body is cut
 * and a hint names how many characters remain.
 */
export function applyBodyFormat(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  format: BodyFormat,
  maxLength?: number,
): string {
  let body: string;

  if (format === 'full') {
    body = bodyText ?? bodyHtml ?? '(no content)';
  } else {
    const base = bodyText ?? (bodyHtml ? stripHtml(bodyHtml) : undefined) ?? '(no content)';
    body = format === 'stripped' ? stripReplyChain(base) : base;
  }

  if (maxLength !== undefined && maxLength > 0 && body.length > maxLength) {
    const remaining = body.length - maxLength;
    body = `${body.slice(0, maxLength)}\n\n… (${remaining} more characters — increase maxLength to read the full body)`;
  }

  return body;
}
