import {
  formatCacheStatus,
  formatDuration,
  parseCacheArgs,
  resolveCacheSettings,
} from './cache-commands.js';

describe('parseCacheArgs', () => {
  it('defaults to the status subcommand', () => {
    expect(parseCacheArgs([])).toMatchObject({ subcommand: 'status', json: false, yes: false });
  });

  it('parses each subcommand', () => {
    expect(parseCacheArgs(['status']).subcommand).toBe('status');
    expect(parseCacheArgs(['clear']).subcommand).toBe('clear');
    expect(parseCacheArgs(['verify']).subcommand).toBe('verify');
  });

  it('parses the account filter, json and yes flags', () => {
    const args = parseCacheArgs(['clear', '--account', 'work', '--yes', '--json']);

    expect(args).toMatchObject({
      subcommand: 'clear',
      account: 'work',
      yes: true,
      json: true,
    });
  });

  it('accepts --account=value and the -y shorthand', () => {
    expect(parseCacheArgs(['clear', '--account=work', '-y'])).toMatchObject({
      account: 'work',
      yes: true,
    });
  });

  it('flags help and rejects an unknown subcommand', () => {
    expect(parseCacheArgs(['--help']).help).toBe(true);
    expect(parseCacheArgs(['status', '-h']).help).toBe(true);
    expect(parseCacheArgs(['bogus']).error).toMatch(/bogus/);
  });

  it('reports a missing --account value rather than silently ignoring it', () => {
    expect(parseCacheArgs(['clear', '--account']).error).toMatch(/--account/);
  });
});

describe('formatDuration', () => {
  it('renders recent ages in human terms', () => {
    expect(formatDuration(5_000)).toBe('just now');
    expect(formatDuration(90_000)).toBe('1 minute ago');
    expect(formatDuration(3 * 60_000)).toBe('3 minutes ago');
    expect(formatDuration(2 * 3_600_000)).toBe('2 hours ago');
    expect(formatDuration(3 * 86_400_000)).toBe('3 days ago');
  });

  it('renders an unknown age as never', () => {
    expect(formatDuration(undefined)).toBe('never');
  });
});

describe('formatCacheStatus', () => {
  const stats = {
    mailboxes: [
      {
        account: 'work',
        mailbox: 'INBOX',
        uidValidity: '100',
        syncTier: 'condstore' as const,
        totalMessages: 1200,
        cachedMessages: 900,
        bodiesCached: 500,
        lastSyncedAt: Date.now() - 120_000,
      },
    ],
    messageCount: 900,
    bodyCount: 500,
    attachmentCount: 12,
    attachmentBytes: 5 * 1024 * 1024,
    sizeBytes: 20 * 1024 * 1024,
  };

  it('reports total size against the budget in human units', () => {
    const out = formatCacheStatus(stats, { maxSizeMb: 500, enabled: true, mailboxes: ['INBOX'] });

    expect(out).toContain('25.0 MB');
    expect(out).toContain('500 MB');
    expect(out).toContain('5%');
  });

  it('breaks the total down into mirror and attachment bytes', () => {
    const out = formatCacheStatus(stats, { maxSizeMb: 500, enabled: true, mailboxes: ['INBOX'] });

    expect(out).toContain('20.0 MB');
    expect(out).toContain('5.0 MB');
    expect(out).toContain('12 attachment');
  });

  it('lists each mailbox with its coverage, bodies and sync age', () => {
    const out = formatCacheStatus(stats, { maxSizeMb: 500, enabled: true, mailboxes: ['INBOX'] });

    expect(out).toContain('work/INBOX');
    expect(out).toContain('900');
    expect(out).toContain('1200');
    expect(out).toContain('condstore');
    expect(out).toContain('2 minutes ago');
  });

  it('says so plainly when caching is switched off', () => {
    const out = formatCacheStatus(stats, { maxSizeMb: 500, enabled: false, mailboxes: ['INBOX'] });

    expect(out).toMatch(/disabled/i);
    expect(out).toContain('cache.enabled');
  });

  it('guides the user when nothing has been mirrored yet', () => {
    const out = formatCacheStatus(
      {
        mailboxes: [],
        messageCount: 0,
        bodyCount: 0,
        attachmentCount: 0,
        attachmentBytes: 0,
        sizeBytes: 0,
      },
      { maxSizeMb: 500, enabled: true, mailboxes: ['INBOX'] },
    );

    expect(out).toMatch(/nothing cached yet/i);
  });

  it('warns when usage has reached the budget', () => {
    const out = formatCacheStatus(
      { ...stats, sizeBytes: 480 * 1024 * 1024, attachmentBytes: 20 * 1024 * 1024 },
      { maxSizeMb: 500, enabled: true, mailboxes: ['INBOX'] },
    );

    expect(out).toMatch(/evict/i);
  });

  it('reports an unlimited budget rather than a 0 MB one', () => {
    const out = formatCacheStatus(stats, { maxSizeMb: 0, enabled: true, mailboxes: ['INBOX'] });

    expect(out).toMatch(/unlimited/i);
    expect(out).not.toContain('0 MB budget');
  });
});

describe('resolveCacheSettings', () => {
  it('uses the configured cache settings when config loads', async () => {
    const settings = await resolveCacheSettings(
      async () =>
        ({
          settings: { cache: { enabled: false, maxSizeMb: 250, mailboxes: ['INBOX', 'Archive'] } },
        }) as never,
    );

    expect(settings).toEqual({ enabled: false, maxSizeMb: 250, mailboxes: ['INBOX', 'Archive'] });
  });

  it('falls back to schema defaults when there is no usable config', async () => {
    // Inspecting or reclaiming local disk must not require working mail
    // credentials — the cache exists independently of any account.
    const settings = await resolveCacheSettings(async () => {
      throw new Error('No configuration found.');
    });

    expect(settings).toEqual({ enabled: true, maxSizeMb: 500, mailboxes: ['INBOX'] });
  });
});
