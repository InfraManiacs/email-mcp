/**
 * Terminal presenters for the email CLI. Pure string builders (no I/O) so they
 * are unit-testable and so the command layer stays thin. Colour is opt-in and
 * off by default for non-TTY output (pipes, tests); the command layer passes
 * `color: process.stdout.isTTY && !process.env.NO_COLOR`.
 */

import type { Email, EmailMeta, Mailbox, PaginatedResult } from '../types/index.js';

interface Opts {
  color: boolean;
}

const C = {
  dim: (s: string, o: Opts) => (o.color ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string, o: Opts) => (o.color ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s: string, o: Opts) => (o.color ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string, o: Opts) => (o.color ? `\x1b[33m${s}\x1b[0m` : s),
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function who(a: { name?: string; address: string }): string {
  return a.name || a.address;
}

function shortDate(iso: string): string {
  // YYYY-MM-DD HH:MM in local-ish form, trimmed from the ISO string without TZ math.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** A one-line-per-message listing with flag glyphs, aligned columns. */
export function formatEmailList(
  result: PaginatedResult<EmailMeta>,
  mailbox: string,
  opts: Opts,
): string {
  if (result.items.length === 0) {
    return C.dim(`No emails in ${mailbox}.`, opts);
  }
  const header = C.bold(
    `${mailbox} — ${result.total} message${result.total === 1 ? '' : 's'}`,
    opts,
  );
  const rows = result.items.map((e) => {
    const unread = e.seen ? ' ' : C.cyan('●', opts);
    const flagged = e.flagged ? C.yellow('★', opts) : ' ';
    const attach = e.hasAttachments ? '📎' : ' ';
    const id = C.dim(e.id.padStart(5), opts);
    const from = truncate(who(e.from), 22).padEnd(22);
    const subj = truncate(e.subject || '(no subject)', 48);
    const date = C.dim(shortDate(e.date), opts);
    return `${unread}${flagged}${attach} ${id}  ${from}  ${subj}  ${date}`;
  });
  const more = result.hasMore
    ? `\n${C.dim(`…more (page ${result.page}; raise --limit or use --page to see the rest)`, opts)}`
    : '';
  return `${header}\n${rows.join('\n')}${more}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A full message: headers, body (text preferred, HTML stripped otherwise), attachments. */
export function formatEmailFull(email: Email, opts: Opts): string {
  const h: string[] = [];
  h.push(
    `${C.bold('From:   ', opts)}${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
  );
  h.push(`${C.bold('To:     ', opts)}${email.to.map((a) => a.address).join(', ')}`);
  if (email.cc?.length)
    h.push(`${C.bold('CC:     ', opts)}${email.cc.map((a) => a.address).join(', ')}`);
  h.push(`${C.bold('Subject:', opts)} ${email.subject || '(no subject)'}`);
  h.push(`${C.bold('Date:   ', opts)}${shortDate(email.date)}`);
  if (email.attachments.length) {
    h.push(
      `${C.bold('Attach: ', opts)}${email.attachments.map((a) => `${a.filename} (${formatSize(a.size)})`).join(', ')}`,
    );
  }
  const body =
    email.bodyText?.trim() ||
    (email.bodyHtml ? stripHtml(email.bodyHtml) : '') ||
    C.dim('(no body)', opts);
  return `${h.join('\n')}\n${C.dim('─'.repeat(60), opts)}\n${body}`;
}

/** Mailbox listing with unread/total counts when the server reported them. */
export function formatMailboxes(boxes: Mailbox[], opts: Opts): string {
  return boxes
    .map((b) => {
      const counts =
        b.totalMessages === undefined
          ? ''
          : C.dim(`  (${b.unseenMessages ?? 0} unread / ${b.totalMessages})`, opts);
      return `${b.path}${counts}`;
    })
    .join('\n');
}
