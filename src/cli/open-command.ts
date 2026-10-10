/**
 * `email-mcp open` — jump from the terminal to an email in the native client.
 *
 *   email-mcp open <id> [--mailbox INBOX] [--account NAME] [--print]
 *
 * Builds a `message://` deep link from the email's Message-ID and hands it to
 * macOS Launch Services, which opens the message in Mail.app regardless of
 * which mailbox it has since been moved to. `--print` (and any non-macOS
 * platform, which has no `message:` handler) writes the bare URL to stdout
 * instead, so it can be piped into reminders, notes, or other tooling.
 */

import { execFile as execFileCb } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';

import { log, outro } from '@clack/prompts';

import { loadConfig } from '../config/loader.js';
import ConnectionManager from '../connections/manager.js';
import ImapService from '../services/imap.service.js';
import OAuthService from '../services/oauth.service.js';
import type { AppConfig } from '../types/index.js';
import { buildMessageUrl } from '../utils/message-url.js';

const execFile = promisify(execFileCb);

export interface OpenPlan {
  action: 'launch' | 'print';
  url: string;
  /** Why the plan fell back to printing (surfaced as a hint on stderr). */
  reason?: string;
}

/** Decide whether to launch the mail client or print the URL. */
export function resolveOpenPlan(opts: {
  url: string;
  print: boolean;
  platform: NodeJS.Platform;
}): OpenPlan {
  if (opts.print) return { action: 'print', url: opts.url };
  if (opts.platform === 'darwin') return { action: 'launch', url: opts.url };
  return {
    action: 'print',
    url: opts.url,
    reason: 'message: links only open natively on macOS — printing the URL instead.',
  };
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
  return config.accounts[0].name;
}

export default async function runOpenCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      mailbox: { type: 'string', default: 'INBOX' },
      print: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const id = positionals[0];
  if (!id) {
    throw new Error('Usage: email-mcp open <id> [--mailbox INBOX] [--account NAME] [--print]');
  }

  const config = await loadConfig();
  const account = resolveAccount(config, values.account);
  const connections = new ConnectionManager(config.accounts, new OAuthService());
  const imap = new ImapService(connections);

  try {
    const email = await imap.getEmail(account, id, values.mailbox);
    const url = buildMessageUrl(email.messageId);
    if (!url) {
      throw new Error(
        `Email ${id} has no Message-ID header, so no message: link can be built for it.`,
      );
    }

    const plan = resolveOpenPlan({ url, print: values.print, platform: process.platform });
    if (plan.action === 'launch') {
      try {
        await execFile('open', [plan.url]);
        outro(`📬 Opening "${email.subject}" in Mail…`);
      } catch {
        // No handler for message: links (e.g. Mail.app removed) — degrade to
        // printing the URL rather than failing the command.
        log.warn('Could not hand the message: link to a mail client — printing it instead.');
        console.log(plan.url);
      }
    } else {
      if (plan.reason) log.warn(plan.reason);
      // Bare URL on stdout so the output stays pipe-friendly.
      console.log(plan.url);
    }
  } finally {
    await connections.closeAll();
  }
}
