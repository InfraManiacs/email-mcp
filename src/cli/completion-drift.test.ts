import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMANDS } from './completion.js';

/**
 * Guards the completion spec (COMMANDS) against drift from the real CLI
 * dispatch. Completion is hand-maintained and a separate source of truth from
 * the `switch` statements, so a new command can ship without a completion
 * entry (this exact gap shipped once). Rather than parse every dispatcher, we
 * assert the two credential-sensitive, account-scoped surfaces stay in sync:
 * the top-level commands (main.ts) and the account subcommands
 * (account-commands.ts). Aliases the completion deliberately omits are listed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, f), 'utf-8');

/** Canonical names a user would tab-complete; aliases are intentionally hidden. */
const TOP_LEVEL_ALIASES = new Set(['help', 'setup']); // setup has its own COMMANDS entry
const ACCOUNT_ALIASES = new Set(['ls', 'new', 'rm', 'remove', 'set-password']);

function caseLabels(source: string): string[] {
  return [...source.matchAll(/case '([a-z][a-z-]*)':/g)].map((m) => m[1]);
}

describe('completion spec stays in sync with the dispatch', () => {
  it('every account subcommand has a completion entry', () => {
    const real = caseLabels(read('account-commands.ts')).filter((c) => !ACCOUNT_ALIASES.has(c));
    const account = COMMANDS.find((c) => c.name === 'account');
    const completed = new Set(account?.subcommands?.map((s) => s.name));
    const missing = [...new Set(real)].filter((c) => !completed.has(c));
    expect(missing).toEqual([]);
  });

  it('account credential subcommands offer dynamic account-name completion', () => {
    const account = COMMANDS.find((c) => c.name === 'account');
    for (const name of ['set-secret', 'migrate-secret', 'edit', 'delete']) {
      const sub = account?.subcommands?.find((s) => s.name === name);
      expect(sub, `completion entry for account ${name}`).toBeDefined();
      expect(sub?.arg, `account ${name} should complete account names`).toBe('accounts');
    }
  });

  it('every top-level command has a completion entry', () => {
    const real = caseLabels(read('../main.ts')).filter((c) => !TOP_LEVEL_ALIASES.has(c));
    const completed = new Set(COMMANDS.map((c) => c.name));
    const missing = [...new Set(real)].filter((c) => !completed.has(c));
    expect(missing).toEqual([]);
  });
});
