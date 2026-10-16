import { buildKeychainStoreArgs, keychainRefFor, keychainSupported } from './keychain-store.js';

describe('keychainSupported', () => {
  // storeSecretNonInteractive has a backend for exactly these two; anywhere
  // else `account add` must not offer what it cannot do.
  it('covers the platforms with a keychain backend', () => {
    expect(keychainSupported('darwin')).toBe(true);
    expect(keychainSupported('linux')).toBe(true);
  });

  it('excludes platforms with no backend', () => {
    expect(keychainSupported('win32')).toBe(false);
    expect(keychainSupported('freebsd')).toBe(false);
  });
});

describe('keychain store helpers', () => {
  it('builds hygienic security args with -w LAST (interactive prompt, no secret in argv)', () => {
    const args = buildKeychainStoreArgs('email-mcp', 'pandia');
    // -U updates an existing item; -w must be the final token so security prompts.
    expect(args).toEqual(['add-generic-password', '-U', '-s', 'email-mcp', '-a', 'pandia', '-w']);
    expect(args[args.length - 1]).toBe('-w');
    // No secret value anywhere — only identifiers.
    expect(args).not.toContain('pw');
  });

  it('produces the config reference line for an account', () => {
    expect(keychainRefFor('pandia')).toBe('keychain:pandia');
  });
});
