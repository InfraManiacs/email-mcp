/**
 * Usage text for the email CLI commands — the single source for both the
 * `--help` output and the error messages thrown on bad input. Pure data.
 */

export const EMAIL_USAGE: Record<string, string> = {
  list: 'email-mcp list [--account NAME] [--mailbox INBOX] [--limit 20] [--page 1] [--unread] [--search TEXT] [--json]',
  read: 'email-mcp read <id> [--account NAME] [--mailbox INBOX] [--mark-read] [--json]',
  search: 'email-mcp search <query> [--account NAME] [--mailbox INBOX] [--limit 20] [--json]',
  mailboxes: 'email-mcp mailboxes [--account NAME] [--json]',
  flag: 'email-mcp flag <id> [--off] [--account NAME] [--mailbox INBOX]',
  delete: 'email-mcp delete <id> [--yes] [--account NAME] [--mailbox INBOX]',
  attach: 'email-mcp attach <id> <filename> [dest-dir] [--account NAME] [--mailbox INBOX]',
  reply:
    'email-mcp reply <id> --body TEXT [--all] [--html] [--attach FILE]... [--account NAME] [--mailbox INBOX]',
  send: 'email-mcp send --to a@b[,c@d] --subject S --body B [--cc ..] [--bcc ..] [--html] [--attach FILE]... [--account NAME]',
};

const DESCRIPTIONS: Record<string, string> = {
  list: 'List emails in a mailbox',
  read: 'Read a full email by id',
  search: 'Search emails',
  mailboxes: 'List mailboxes/folders',
  flag: 'Flag or unflag an email',
  delete: 'Delete an email',
  attach: 'Download an attachment to disk',
  reply: 'Reply to an email',
  send: 'Send a new email',
};

/**
 * One `name  description` row per mail command, indented for a help listing.
 *
 * Shared with the top-level `email-mcp help` so these nine commands are
 * described in exactly one place — they were once listed here and in shell
 * completion but missing from the top-level help entirely.
 *
 * @param width column the description starts in, relative to the name
 */
export function mailCommandRows(width = 11): string {
  return Object.keys(EMAIL_USAGE)
    .map((c) => `  ${c.padEnd(width)}${DESCRIPTIONS[c]}`)
    .join('\n');
}

/**
 * Usage for a single command, or the full overview when no command is given.
 * `--account` and `--json` are documented once as shared options.
 */
export function emailUsage(command?: string): string {
  if (command && EMAIL_USAGE[command]) {
    return `Usage: ${EMAIL_USAGE[command]}`;
  }
  const rows = mailCommandRows();
  return [
    'Read and send email from the terminal.',
    '',
    'Commands:',
    rows,
    '',
    'Shared options:',
    '  --account NAME   Account to use (default: the sole/first configured account)',
    '  --json           Machine-readable JSON output (list, read, search, mailboxes)',
    '',
    'Run `email-mcp <command> --help` for a command’s full options.',
  ].join('\n');
}
