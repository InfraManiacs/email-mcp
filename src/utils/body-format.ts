/**
 * Body formatting shared by every surface that renders an email body —
 * get_email, get_emails, get_thread, and the CLI. One definition so the
 * `format` contract cannot drift between tools (it previously did: three
 * near-duplicates with different HTML handling).
 */

import { stripHtml } from './html.js';
import { stripReplyChain } from './reply-chain.js';

export type BodyFormat = 'full' | 'text' | 'stripped';

/** RFC 3676 §4.3: a signature separator, hard despite its trailing space. */
const SIGNATURE_SEPARATOR = '-- ';

/**
 * Undo the soft line wrapping of a `text/plain; format=flowed` body (RFC 3676).
 *
 * Thunderbird, Apple Mail and most Linux clients send flowed text: a line
 * ending in a space continues on the next one, and only a line without that
 * space is a real break. Read literally, a paragraph arrives hard-wrapped at
 * seventy-two columns with trailing whitespace — which also leaves
 * stripReplyChain matching against lines the sender never broke.
 *
 * `delSp` mirrors the DelSp parameter: when the sender set it, the trailing
 * space marked the wrap and is not part of the text.
 */
export function unflowFormatFlowed(text: string, delSp = false): string {
  const lines: string[] = [];
  let pending: string | undefined;
  let pendingDepth = 0;

  const flush = (): void => {
    if (pending !== undefined) {
      // Re-add the one space after the quote marks that space-stuffing ate, so
      // the result reads — and re-parses — as an ordinary quoted line.
      lines.push(pendingDepth > 0 ? `${'>'.repeat(pendingDepth)} ${pending}` : pending);
      pending = undefined;
    }
  };

  text.split(/\r?\n/).forEach((rawLine) => {
    const depth = /^>+/.exec(rawLine)?.[0].length ?? 0;
    let line = rawLine.slice(depth);
    // One leading space is stuffing the sender added to protect a line opening
    // with a space, ">" or "From ".
    if (line.startsWith(' ')) line = line.slice(1);

    // A wrap never spans a change of quote depth.
    if (pending !== undefined && depth !== pendingDepth) flush();

    const soft = line.endsWith(' ') && line !== SIGNATURE_SEPARATOR;
    const content = soft && delSp ? line.slice(0, -1) : line;

    if (pending === undefined) {
      pending = content;
      pendingDepth = depth;
    } else {
      pending += content;
    }

    if (!soft) flush();
  });

  flush();
  return lines.join('\n');
}

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
