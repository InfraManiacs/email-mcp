import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSecret } from './secret-resolver.js';

/**
 * Exercises the REAL macOS `security` binary (the default runner — no fake),
 * against an isolated throwaway keychain. Skips on non-macOS (e.g. Linux CI).
 * The keychain is added to the search list so the default `find-generic-password`
 * resolves it, and both the keychain and the original search list are always
 * restored.
 */
const darwin = platform() === 'darwin';

describe.runIf(darwin)('resolveSecret against the real macOS Keychain', () => {
  let dir: string;
  let keychain: string;
  let originalList: string[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kc-test-'));
    keychain = join(dir, 'email-mcp-test.keychain-db');
    execFileSync('security', ['create-keychain', '-p', '', keychain]);
    execFileSync('security', ['unlock-keychain', '-p', '', keychain]);

    originalList = execFileSync('security', ['list-keychains', '-d', 'user'])
      .toString()
      .split('\n')
      .map((l) => l.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    execFileSync('security', ['list-keychains', '-d', 'user', '-s', keychain, ...originalList]);

    // Test secrets only; argv is acceptable for a throwaway fixture.
    execFileSync('security', [
      'add-generic-password',
      '-U',
      '-s',
      'email-mcp',
      '-a',
      'acct-one',
      '-w',
      'secret-one',
      keychain,
    ]);
    execFileSync('security', [
      'add-generic-password',
      '-U',
      '-s',
      'email-mcp',
      '-a',
      'acct-two',
      '-w',
      'secret-two-longer',
      keychain,
    ]);
    execFileSync('security', [
      'add-generic-password',
      '-U',
      '-s',
      'custom-svc',
      '-a',
      'scoped',
      '-w',
      'scoped-secret',
      keychain,
    ]);
  });

  afterAll(() => {
    try {
      execFileSync('security', ['list-keychains', '-d', 'user', '-s', ...originalList]);
    } finally {
      try {
        execFileSync('security', ['delete-keychain', keychain]);
      } catch {
        // best effort
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a secret for an account under the default service', async () => {
    expect(await resolveSecret('keychain:acct-one')).toBe('secret-one');
  });

  it('keeps accounts independent (multi-account)', async () => {
    expect(await resolveSecret('keychain:acct-two')).toBe('secret-two-longer');
  });

  it('honours an explicit service in keychain:<svc>/<account>', async () => {
    expect(await resolveSecret('keychain:custom-svc/scoped')).toBe('scoped-secret');
  });

  it('throws a clear error for an account with no stored secret', async () => {
    await expect(resolveSecret('keychain:no-such-account')).rejects.toThrow(/no-such-account/);
  });
});
