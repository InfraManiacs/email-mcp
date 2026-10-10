/**
 * macOS Keychain store helpers for `email-mcp account set-secret`.
 *
 * Storing a secret must never put it in argv (visible via `ps`). The `security`
 * CLI supports exactly one hygienic path for that: pass `-w` as the FINAL
 * argument with no value, which makes it prompt on the controlling terminal
 * (and confirm). So the stored secret is typed by the human into security's
 * own prompt — it never passes through this process or its argv.
 *
 * Multi-account: each account is a distinct generic-password item sharing the
 * service "email-mcp", keyed by its account attribute. `-U` updates in place
 * when re-running for an existing account.
 */

import { spawn } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'email-mcp';

/** Args for `security` to store/update account's secret via its own prompt. */
export function buildKeychainStoreArgs(service: string, account: string): string[] {
  return ['add-generic-password', '-U', '-s', service, '-a', account, '-w'];
}

/** The config.toml value that points `password` at this account's Keychain item. */
export function keychainRefFor(account: string): string {
  return `keychain:${account}`;
}

/**
 * Run `security` interactively so the user types the secret into its prompt.
 * stdio is inherited: security owns the terminal for the prompt. Resolves on
 * exit 0, rejects otherwise. The secret never touches this process.
 */
export function runKeychainStore(account: string, service = KEYCHAIN_SERVICE): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', buildKeychainStoreArgs(service, account), {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`security exited with code ${code}`));
    });
  });
}

/**
 * Store a secret non-interactively (used by `migrate-secret`, where the value
 * comes from the existing config rather than a human).
 *
 *   • Linux: `secret-tool store` reads the secret from stdin — argv-clean.
 *   • macOS: the `security` CLI has no stdin path and its interactive prompt
 *     cannot be driven reliably, so the value goes on argv for the brief life
 *     of the child process. This is a one-time migration that REMOVES a
 *     permanent plaintext-at-rest copy, so it is a net improvement; new
 *     secrets should use `set-secret`, whose prompt never touches argv.
 */
export function storeSecretNonInteractive(
  account: string,
  secret: string,
  service = KEYCHAIN_SERVICE,
  osPlatform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (osPlatform === 'linux') {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'secret-tool',
        ['store', '--label', `email-mcp ${account}`, 'service', service, 'account', account],
        { stdio: ['pipe', 'inherit', 'inherit'] },
      );
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`secret-tool exited with code ${code}`)),
      );
      child.stdin.write(secret);
      child.stdin.end();
    });
  }

  if (osPlatform === 'darwin') {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'security',
        ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret],
        { stdio: 'ignore' },
      );
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`security exited with code ${code}`)),
      );
    });
  }

  return Promise.reject(
    new Error(
      `Keychain storage is supported on macOS and Linux, not "${osPlatform}". Use an "env:<VAR>" reference instead.`,
    ),
  );
}
