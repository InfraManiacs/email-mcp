/**
 * Email provider auto-detection by domain.
 *
 * Maps common email domains to their IMAP/SMTP server settings.
 */

import type { ProviderConfig } from '../types/index.js';

export const PROVIDERS: ProviderConfig[] = [
  {
    name: 'Gmail',
    maxAttachmentMb: 25,
    domains: ['gmail.com', 'googlemail.com'],
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.gmail.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    notes: 'Requires an App Password (enable 2FA first) or OAuth2',
    oauth2: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://mail.google.com/'],
    },
  },
  {
    name: 'Outlook / Hotmail',
    maxAttachmentMb: 20,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'outlook.de', 'outlook.co.uk'],
    imap: {
      host: 'outlook.office365.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.office365.com',
      port: 587,
      tls: false,
      starttls: true,
      verifySsl: true,
    },
    oauth2: {
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: [
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        'https://outlook.office.com/SMTP.Send',
        'offline_access',
      ],
    },
  },
  {
    name: 'Yahoo Mail',
    maxAttachmentMb: 25,
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.de', 'ymail.com'],
    imap: {
      host: 'imap.mail.yahoo.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.mail.yahoo.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    notes: 'Requires an App Password',
  },
  {
    name: 'iCloud',
    maxAttachmentMb: 20,
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: {
      host: 'imap.mail.me.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.mail.me.com',
      port: 587,
      tls: false,
      starttls: true,
      verifySsl: true,
    },
    notes: 'Requires an App-Specific Password',
  },
  {
    name: 'Fastmail',
    maxAttachmentMb: 50,
    domains: ['fastmail.com', 'fastmail.fm'],
    imap: {
      host: 'imap.fastmail.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.fastmail.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
  },
  {
    name: 'ProtonMail Bridge',
    maxAttachmentMb: 25,
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    imap: {
      host: '127.0.0.1',
      port: 1143,
      tls: false,
      starttls: true,
      verifySsl: false,
    },
    smtp: {
      host: '127.0.0.1',
      port: 1025,
      tls: false,
      starttls: true,
      verifySsl: false,
    },
    notes: 'Requires ProtonMail Bridge running locally',
  },
  {
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imap: {
      host: 'imap.zoho.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.zoho.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
  },
  {
    name: 'GMX',
    maxAttachmentMb: 20,
    domains: ['gmx.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'],
    imap: {
      host: 'imap.gmx.net',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'mail.gmx.net',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
  },
];

/**
 * Detect email provider from an email address.
 * Returns the matching provider config or undefined.
 */
export function detectProvider(email: string): ProviderConfig | undefined {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return undefined;

  return PROVIDERS.find((p) => p.domains.includes(domain));
}

/**
 * Identify the provider behind a configured account.
 *
 * The SMTP host is the strongest signal (it also catches custom domains
 * routed through a known provider, e.g. ProtonMail Bridge on 127.0.0.1);
 * the email domain is the fallback for custom relays.
 */
export function findProviderForAccount(account: {
  email: string;
  smtp: { host: string };
}): ProviderConfig | undefined {
  const host = account.smtp.host.toLowerCase();
  const byHost = PROVIDERS.find((p) => p.smtp.host.toLowerCase() === host);
  if (byHost) return byHost;
  return detectProvider(account.email);
}
