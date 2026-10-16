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
 * Collapse an embedded line break.
 *
 * The attribution line is not "> "-quoted, so a crafted display name or
 * Date header could otherwise forge a second "On ... wrote:" line, or inject
 * text a reader would take as the message's own — the same risk
 * forwardEmail's forward header already guards against.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
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
  const quoted = body
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return `\n\n${attribution}\n${quoted}`;
}

/**
 * Produce an HTML quoted block for an HTML reply, wrapped in the standard
 * `<blockquote type="cite">` that mail clients recognize as quoted material.
 */
export function quoteOriginalAsHtml(original: Email): string {
  const esc = (s: string) => sanitizeTemplateVariable(s, true);
  const attribution = `On ${esc(oneLine(original.date))}, ${esc(formatSender(original.from))} wrote:`;
  let inner: string;
  if (original.bodyHtml) {
    inner = original.bodyHtml;
  } else if (original.bodyText) {
    inner = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${esc(original.bodyText)}</pre>`;
  } else {
    inner = '';
  }
  return (
    `<br><br>${attribution}<br>` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`
  );
}
