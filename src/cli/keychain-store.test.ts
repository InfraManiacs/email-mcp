import { buildKeychainStoreArgs, keychainRefFor } from './keychain-store.js';

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
