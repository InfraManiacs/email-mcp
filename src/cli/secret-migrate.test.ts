import { extractAccountPassword, rewritePasswordToKeychainRef } from './secret-migrate.js';

const CONFIG = `# Email MCP config
[settings]
rate_limit = 10

[[accounts]]
name = "pandia"
email = "me@pandia.io"
password = "s3cr3t-app-pw"   # Proton Bridge

[accounts.imap]
host = "127.0.0.1"

[[accounts]]
name = "work"
email = "me@work.com"
password = "other-pw"

[accounts.smtp]
host = "smtp.work.com"
`;

describe('extractAccountPassword', () => {
  it('returns the plaintext password for the named account', () => {
    expect(extractAccountPassword(CONFIG, 'pandia')).toBe('s3cr3t-app-pw');
    expect(extractAccountPassword(CONFIG, 'work')).toBe('other-pw');
  });

  it('returns null for an unknown account', () => {
    expect(extractAccountPassword(CONFIG, 'ghost')).toBeNull();
  });

  it('returns null when the password is already a keychain/env reference', () => {
    const cfg = CONFIG.replace('"s3cr3t-app-pw"   # Proton Bridge', '"keychain:pandia"');
    expect(extractAccountPassword(cfg, 'pandia')).toBeNull();
  });
});

describe('rewritePasswordToKeychainRef', () => {
  it('replaces only the target account password line, preserving comments', () => {
    const out = rewritePasswordToKeychainRef(CONFIG, 'pandia');
    expect(out).toContain('password = "keychain:pandia"');
    expect(out).toContain('password = "other-pw"'); // work untouched
    expect(out).toContain('# Email MCP config'); // comments preserved
    expect(out).toContain('rate_limit = 10');
  });

  it('is idempotent — re-running leaves an existing keychain ref unchanged', () => {
    const once = rewritePasswordToKeychainRef(CONFIG, 'pandia');
    const twice = rewritePasswordToKeychainRef(once, 'pandia');
    expect(twice).toBe(once);
  });

  it('throws when the account is not present', () => {
    expect(() => rewritePasswordToKeychainRef(CONFIG, 'ghost')).toThrow(/ghost/);
  });

  it('does not touch another account sharing a password value', () => {
    const cfg = CONFIG.replace('"other-pw"', '"s3cr3t-app-pw"'); // same value, different account
    const out = rewritePasswordToKeychainRef(cfg, 'pandia');
    // work still has the literal; only pandia became a ref
    expect(out.match(/password = "s3cr3t-app-pw"/g)?.length).toBe(1);
    expect(out).toContain('password = "keychain:pandia"');
  });
});
