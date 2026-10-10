import { findProviderForAccount } from './providers.js';
import { resolveSendLimitMb } from './send-limit.js';

/** Minimal account shape for limit resolution. */
function account(over: {
  email?: string;
  smtpHost?: string;
  smtpPort?: number;
  maxAttachmentMb?: number;
}) {
  return {
    email: over.email ?? 'someone@example.com',
    smtp: { host: over.smtpHost ?? 'smtp.example.com', port: over.smtpPort ?? 465 },
    maxAttachmentMb: over.maxAttachmentMb,
  };
}

describe('findProviderForAccount', () => {
  it('matches by SMTP host regardless of the email domain', () => {
    const p = findProviderForAccount(
      account({ email: 'me@custom-domain.io', smtpHost: '127.0.0.1' }),
    );
    expect(p?.name).toBe('ProtonMail Bridge');
  });

  it('matches SMTP hosts case-insensitively', () => {
    const p = findProviderForAccount(account({ smtpHost: 'SMTP.GMAIL.COM' }));
    expect(p?.name).toBe('Gmail');
  });

  it('falls back to matching the email domain', () => {
    const p = findProviderForAccount(
      account({ email: 'me@gmail.com', smtpHost: 'relay.corp.lan' }),
    );
    expect(p?.name).toBe('Gmail');
  });

  it('returns undefined for unknown providers', () => {
    expect(findProviderForAccount(account({}))).toBeUndefined();
  });
});

describe('resolveSendLimitMb', () => {
  it('an explicit per-account limit wins over everything', () => {
    expect(
      resolveSendLimitMb(account({ smtpHost: 'smtp.gmail.com', maxAttachmentMb: 50 }), 25),
    ).toBe(50);
  });

  it('applies a known provider limit when it is stricter than the global setting', () => {
    // Outlook.com caps messages at 20 MB — below the 25 MB global default.
    expect(resolveSendLimitMb(account({ smtpHost: 'smtp.office365.com' }), 25)).toBe(20);
  });

  it('keeps the global setting when the provider allows more', () => {
    // Fastmail allows 50 MB, but the configured global cap stays authoritative.
    expect(resolveSendLimitMb(account({ smtpHost: 'smtp.fastmail.com' }), 25)).toBe(25);
  });

  it('uses the global setting for unknown providers', () => {
    expect(resolveSendLimitMb(account({}), 30)).toBe(30);
  });

  it('detects the provider via email domain when the SMTP host is custom', () => {
    expect(
      resolveSendLimitMb(account({ email: 'me@gmail.com', smtpHost: 'relay.corp.lan' }), 40),
    ).toBe(25);
  });
});
