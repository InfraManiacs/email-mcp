/**
 * Email CLI commands — read and compose mail straight from the terminal,
 * reusing the same IMAP/SMTP services the MCP tools use (no duplicated logic).
 *
 *   email-mcp list [--unread] [--mailbox INBOX] [--limit 20] [--search TEXT]
 *   email-mcp read <id> [--mark-read] [--mailbox INBOX]
 *   email-mcp search <query>
 *   email-mcp mailboxes
 *   email-mcp flag <id> [--off]
 *   email-mcp delete <id> [--yes]
 *   email-mcp attach <id> <filename> [dest-dir]
 *   email-mcp reply <id> --body TEXT [--all] [--attach FILE]...
 *   email-mcp send --to a@b,c@d --subject S --body B [--cc ..] [--bcc ..] [--html] [--attach FILE]...
 *
 * Flags are parsed with Node's built-in `util.parseArgs` (no extra dependency).
 * `--account` selects among configured accounts; it may be omitted when only
 * one is configured, or defaults to the first otherwise.
 */

import { parseArgs } from 'node:util';

import { confirm, isCancel } from '@clack/prompts';

import { loadConfig } from '../config/loader.js';
import ConnectionManager from '../connections/manager.js';
import RateLimiter from '../safety/rate-limiter.js';
import { safeAttachmentFilename } from '../safety/validation.js';
import { prepareAttachments } from '../services/attachments.js';
import ImapService from '../services/imap.service.js';
import OAuthService from '../services/oauth.service.js';
import SmtpService from '../services/smtp.service.js';
import type { AppConfig } from '../types/index.js';
import { emailUsage } from './email-help.js';
import { formatEmailFull, formatEmailList, formatMailboxes, formatSize } from './presenters.js';

const jsonOut = (data: unknown) => console.log(JSON.stringify(data, null, 2));

interface CliServices {
  config: AppConfig;
  imap: ImapService;
  smtp: SmtpService;
  close: () => Promise<void>;
}

/** Light service graph for a one-shot command — no watcher/scheduler/hooks. */
async function buildCliServices(): Promise<CliServices> {
  const config = await loadConfig();
  const oauth = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauth);
  const imap = new ImapService(connections);
  const smtp = new SmtpService(connections, new RateLimiter(config.settings.rateLimit), imap);
  return { config, imap, smtp, close: () => connections.closeAll() };
}

/** Resolve the account to act on: explicit flag, else the sole/first account. */
function resolveAccount(config: AppConfig, requested?: string): string {
  if (requested) {
    const found = config.accounts.find((a) => a.name === requested);
    if (!found) {
      const names = config.accounts.map((a) => a.name).join(', ');
      throw new Error(`Unknown account "${requested}". Configured: ${names || '(none)'}.`);
    }
    return requested;
  }
  if (config.accounts.length === 0) {
    throw new Error('No accounts configured. Run `email-mcp account add` first.');
  }
  return config.accounts[0]?.name ?? config.accounts[0]?.email ?? '';
}

const colorOpts = () => ({ color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR });

function toList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(svc: CliServices, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      mailbox: { type: 'string', default: 'INBOX' },
      limit: { type: 'string', default: '20' },
      page: { type: 'string', default: '1' },
      unread: { type: 'boolean', default: false },
      search: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const account = resolveAccount(svc.config, values.account);
  const result = await svc.imap.listEmails(account, {
    mailbox: values.mailbox,
    pageSize: Number(values.limit),
    page: Number(values.page),
    ...(values.unread ? { seen: false } : {}),
    ...(values.search ? { subject: values.search } : {}),
  });
  if (values.json) {
    jsonOut(result);
    return;
  }
  console.log(formatEmailList(result, values.mailbox as string, colorOpts()));
}

async function cmdRead(svc: CliServices, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      mailbox: { type: 'string', default: 'INBOX' },
      'mark-read': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) throw new Error(emailUsage('read'));
  const account = resolveAccount(svc.config, values.account);
  const email = await svc.imap.getEmail(account, id, values.mailbox);
  if (values.json) {
    jsonOut(email);
  } else {
    console.log(formatEmailFull(email, colorOpts()));
  }
  if (values['mark-read']) {
    await svc.imap.setFlags(account, id, values.mailbox as string, 'read');
    if (!values.json) console.log(`\nMarked as read.`);
  }
}

async function cmdSearch(svc: CliServices, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      mailbox: { type: 'string', default: 'INBOX' },
      limit: { type: 'string', default: '20' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const query = positionals.join(' ').trim();
  if (!query) throw new Error(emailUsage('search'));
  const account = resolveAccount(svc.config, values.account);
  const result = await svc.imap.searchEmails(account, query, {
    mailbox: values.mailbox,
    pageSize: Number(values.limit),
  });
  if (values.json) {
    jsonOut(result);
    return;
  }
  console.log(formatEmailList(result, `${values.mailbox} · "${query}"`, colorOpts()));
}

async function cmdMailboxes(svc: CliServices, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { account: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  const account = resolveAccount(svc.config, values.account);
  const boxes = await svc.imap.listMailboxes(account);
  if (values.json) {
    jsonOut(boxes);
    return;
  }
  console.log(formatMailboxes(boxes, colorOpts()));
}

async function cmdFlag(svc: CliServices, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      mailbox: { type: 'string', default: 'INBOX' },
      off: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) throw new Error('Usage: email-mcp flag <id> [--off] [--mailbox INBOX]');
  const account = resolveAccount(svc.config, values.account);
  await svc.imap.setFlags(account, id, values.mailbox as string, values.off ? 'unflag' : 'flag');
  console.log(values.off ? `Unflagged ${id}.` : `Flagged ${id}.`);
}

async function cmdDelete(svc: CliServices, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      mailbox: { type: 'string', default: 'INBOX' },
      yes: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) throw new Error('Usage: email-mcp delete <id> [--yes] [--mailbox INBOX]');
  const account = resolveAccount(svc.config, values.account);
  if (!values.yes) {
    const ok = await confirm({ message: `Delete message ${id} from ${values.mailbox}?` });
    if (isCancel(ok) || !ok) {
      console.log('Cancelled.');
      return;
    }
  }
  await svc.imap.deleteEmail(account, id, values.mailbox);
  console.log(`Deleted ${id}.`);
}

async function cmdAttach(svc: CliServices, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { account: { type: 'string' }, mailbox: { type: 'string', default: 'INBOX' } },
    allowPositionals: true,
  });
  const [id, filename, destDir = '.'] = positionals;
  if (!id || !filename) {
    throw new Error(
      'Usage: email-mcp attach <id> <filename> [dest-dir] — see filenames with `read <id>`.',
    );
  }
  const account = resolveAccount(svc.config, values.account);
  // The service defaults to a 5 MB cap (sized for returning base64 to an LLM);
  // a terminal download to disk has no such constraint, so allow up to 50 MB.
  const CLI_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
  const dl = await svc.imap.downloadAttachment(
    account,
    id,
    values.mailbox as string,
    filename,
    CLI_ATTACHMENT_MAX_BYTES,
  );
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { resolve, sep } = await import('node:path');
  await mkdir(destDir, { recursive: true });
  // The name is the sender's to choose, so it is reduced to a bare filename
  // before it reaches the filesystem. The containment check below cannot fire
  // given that guarantee; it is here so the invariant fails loudly rather than
  // silently if it is ever weakened.
  const base = resolve(destDir);
  const out = resolve(base, safeAttachmentFilename(dl.filename));
  if (out !== base && !out.startsWith(base + sep)) {
    throw new Error(`Refusing to write "${dl.filename}" outside ${base}.`);
  }
  await writeFile(out, Buffer.from(dl.contentBase64, 'base64'));
  console.log(`Saved ${dl.filename} (${formatSize(dl.size)}) → ${out}`);
}

async function cmdReply(svc: CliServices, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      mailbox: { type: 'string', default: 'INBOX' },
      body: { type: 'string' },
      all: { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
      attach: { type: 'string', multiple: true, default: [] },
    },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id || !values.body) {
    throw new Error('Usage: email-mcp reply <id> --body "text" [--all] [--attach FILE]...');
  }
  const account = resolveAccount(svc.config, values.account);
  const prepared = (values.attach as string[]).length
    ? await prepareAttachments(values.attach as string[], svc.config.settings.send.maxAttachmentMb)
    : null;
  const result = await svc.smtp.replyToEmail(account, {
    emailId: id,
    mailbox: values.mailbox,
    body: values.body,
    replyAll: values.all,
    html: values.html,
    attachments: prepared?.attachments,
  });
  console.log(`✅ Reply sent. Message-ID: ${result.messageId}`);
}

async function cmdSend(svc: CliServices, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      to: { type: 'string' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      html: { type: 'boolean', default: false },
      attach: { type: 'string', multiple: true, default: [] },
    },
    allowPositionals: false,
  });
  const to = toList(values.to);
  if (to.length === 0 || values.subject === undefined || values.body === undefined) {
    throw new Error(
      'Usage: email-mcp send --to a@b[,c@d] --subject "S" --body "B" [--cc ..] [--bcc ..] [--html] [--attach FILE]...',
    );
  }
  const account = resolveAccount(svc.config, values.account);
  const prepared = (values.attach as string[]).length
    ? await prepareAttachments(values.attach as string[], svc.config.settings.send.maxAttachmentMb)
    : null;
  const result = await svc.smtp.sendEmail(account, {
    to,
    cc: toList(values.cc),
    bcc: toList(values.bcc),
    subject: values.subject,
    body: values.body,
    html: values.html,
    attachments: prepared?.attachments,
  });
  console.log(`✅ Sent to ${to.join(', ')}. Message-ID: ${result.messageId}`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, (svc: CliServices, argv: string[]) => Promise<void>> = {
  list: cmdList,
  read: cmdRead,
  search: cmdSearch,
  mailboxes: cmdMailboxes,
  flag: cmdFlag,
  delete: cmdDelete,
  attach: cmdAttach,
  reply: cmdReply,
  send: cmdSend,
};

const EMAIL_COMMANDS = Object.keys(HANDLERS);

export default async function runEmailCommand(command: string, argv: string[]): Promise<void> {
  const handler = HANDLERS[command];
  if (!handler) {
    console.error(`Unknown email command "${command}". One of: ${EMAIL_COMMANDS.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  // Answer --help before touching the network: building services would connect
  // to IMAP/SMTP, which is the opposite of what someone asking for help wants.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(emailUsage(command));
    return;
  }
  const svc = await buildCliServices();
  try {
    await handler(svc, argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await svc.close();
  }
}
