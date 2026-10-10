/**
 * Helpers for `account migrate-secret`: move an account's plaintext password
 * out of config.toml and into the OS keychain, leaving a `keychain:<account>`
 * reference behind.
 *
 * These operate on the config TEXT (not the parsed object) so comments and
 * formatting survive — a parse/re-stringify round-trip would drop them. The
 * edit is scoped to the target account's own `password` line, found by walking
 * account blocks, so a shared password value elsewhere is never touched.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { CONFIG_FILE } from '../config/loader.js';
import { resolveSecret } from '../config/secret-resolver.js';
import { keychainRefFor, storeSecretNonInteractive } from './keychain-store.js';

const ACCOUNT_HEADER = /^\s*\[\[accounts\]\]/;
const NAME_LINE = /^\s*name\s*=\s*"([^"]+)"/;
const PASSWORD_LINE = /^(\s*)password\s*=\s*"([^"]*)"/;

function isReference(value: string): boolean {
  return value.startsWith('keychain:') || value.startsWith('env:');
}

/**
 * Return the plaintext password for an account, or null if the account is
 * absent or its password is already an indirection reference.
 */
export function extractAccountPassword(configText: string, account: string): string | null {
  let current: string | null = null;
  for (const line of configText.split('\n')) {
    if (ACCOUNT_HEADER.test(line)) current = null;
    const nameMatch = line.match(NAME_LINE);
    if (nameMatch) current = nameMatch[1];
    if (current === account) {
      const pwMatch = line.match(PASSWORD_LINE);
      if (pwMatch) {
        const value = pwMatch[2];
        return isReference(value) ? null : value;
      }
    }
  }
  return null;
}

/**
 * Replace the target account's `password` line with `password = "keychain:<account>"`.
 * Idempotent (an existing keychain ref is left as-is). Throws if the account
 * has no password line at all.
 */
export function rewritePasswordToKeychainRef(configText: string, account: string): string {
  const ref = `keychain:${account}`;
  const lines = configText.split('\n');
  let current: string | null = null;
  let touched = false;

  const out = lines.map((line) => {
    if (ACCOUNT_HEADER.test(line)) current = null;
    const nameMatch = line.match(NAME_LINE);
    if (nameMatch) current = nameMatch[1];
    if (current === account) {
      const pwMatch = line.match(PASSWORD_LINE);
      if (pwMatch) {
        touched = true;
        if (isReference(pwMatch[2])) return line; // idempotent
        return `${pwMatch[1]}password = "${ref}"`;
      }
    }
    return line;
  });

  if (!touched) {
    throw new Error(`No password line found for account "${account}" in the config.`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration (impure — reads config, writes keychain, rewrites file)
// ---------------------------------------------------------------------------

/**
 * Move one account's plaintext password out of config.toml into the OS
 * keychain, verify the stored value, then rewrite the config to a
 * `keychain:<account>` reference (0600). Idempotent and safe to re-run.
 */
export async function migrateAccountSecret(
  account: string,
  configPath = CONFIG_FILE,
): Promise<void> {
  const text = await readFile(configPath, 'utf-8');
  const plaintext = extractAccountPassword(text, account);

  if (plaintext === null) {
    console.log(
      `Account "${account}" has no plaintext password to migrate ` +
        `(it is absent, or already a keychain:/env: reference). Nothing to do.`,
    );
    return;
  }

  console.log(`Storing the secret for "${account}" in the OS keychain…`);
  await storeSecretNonInteractive(account, plaintext);

  // Verify the keychain now returns exactly what we stored — compare hashes,
  // never the values themselves.
  const readBack = await resolveSecret(keychainRefFor(account));
  const h = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);
  if (h(readBack) !== h(plaintext)) {
    throw new Error(
      `Keychain verification failed for "${account}": the stored value does not match. ` +
        `The config was NOT changed; your plaintext password is intact.`,
    );
  }

  const rewritten = rewritePasswordToKeychainRef(text, account);
  await writeFile(configPath, rewritten, { encoding: 'utf-8', mode: 0o600 });

  console.log(`✅ Migrated "${account}" to the keychain. config.toml now reads:`);
  console.log(`     password = "${keychainRefFor(account)}"`);
  console.log(`Restart the server for the change to take effect.`);
}
