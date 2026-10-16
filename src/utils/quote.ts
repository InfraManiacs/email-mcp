/**
 * Reply-quoting helpers — produce the "On <date>, <sender> wrote:" block
 * + quoted original body that desktop clients (Thunderbird, Apple Mail,
 * Outlook) automatically prepend to outgoing replies.
 *
 * Without this, replies sent through the MCP show up to the recipient as
 * bare text with no context — they have to dig into the prior thread to
 * understand what's being answered.
 *
 * Reuses the same stripHtml/sanitizeTemplateVariable forwardEmail already
 * quotes the original message with, rather than a second implementation.
 */

import { sanitizeTemplateVariable } from '../safety/validation.js';
import type { Email, EmailAddress } from '../types/index.js';
import { stripHtml } from './html.js';

/**
 * Every character a renderer might treat as a line break: CRLF, lone CR,
 * LF, NEL (U+0085), and the Unicode LINE/PARAGRAPH SEPARATORs (U+2028,
 * U+2029) — `\n` alone misses the last three, which `.split('\n')` or a
 * naive `oneLine` would then let through disguised as ordinary text.
 */
const LINE_BREAK_RE = /\r\n|[\r\n\u0085\u2028\u2029]/g;

/**
 * Collapse an embedded line break.
 *
 * The attribution line is not "> "-quoted, so a crafted display name or
 * Date header could otherwise forge a second "On ... wrote:" line, or inject
 * text a reader would take as the message's own — the same risk
 * forwardEmail's forward header already guards against.
 */
function oneLine(value: string): string {
  return value.replace(LINE_BREAK_RE, ' ').trim();
}

function formatSender(addr: EmailAddress): string {
  return addr.name ? `${oneLine(addr.name)} <${oneLine(addr.address)}>` : oneLine(addr.address);
}

/**
 * Produce a plain-text quoted block for a reply (Thunderbird/Mutt style):
 *
 *     On <date>, <sender> wrote:
 *     > line 1
 *     > line 2
 */
export function quoteOriginalAsText(original: Email): string {
  const attribution = `On ${oneLine(original.date)}, ${formatSender(original.from)} wrote:`;
  const body = original.bodyText ?? (original.bodyHtml ? stripHtml(original.bodyHtml) : '');
  // Normalize every line-break variant to "\n" first — a lone CR or a
  // Unicode line separator would otherwise survive .split('\n') as part of
  // what this treats as a single "line", reaching the output unquoted.
  const quoted = body
    .replace(LINE_BREAK_RE, '\n')
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return `\n\n${attribution}\n${quoted}`;
}

/**
 * Produce an HTML quoted block for an HTML reply, wrapped in the standard
 * `<blockquote type="cite">` that mail clients recognize as quoted material.
 *
 * The original is always quoted as escaped text in a <pre>, never as raw
 * HTML: `bodyHtml` is sender-controlled, and embedding it unsanitized would
 * let an unbalanced tag (e.g. a stray `</blockquote>`) break out of the
 * quote boundary and have the rest render as if it were the reply's own
 * content. stripHtml first, same as the plain-text path, trades the
 * original's own formatting for that guarantee.
 */
export function quoteOriginalAsHtml(original: Email): string {
  const esc = (s: string) => sanitizeTemplateVariable(s, true);
  const attribution = `On ${esc(oneLine(original.date))}, ${esc(formatSender(original.from))} wrote:`;
  const plainOriginal =
    original.bodyText ?? (original.bodyHtml ? stripHtml(original.bodyHtml) : '');
  const inner = plainOriginal
    ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${esc(plainOriginal)}</pre>`
    : '';
  return (
    `<br><br>${attribution}<br>` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`
  );
}
