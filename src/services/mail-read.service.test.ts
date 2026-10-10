import { describe, expect, it, vi } from 'vitest';
import CacheStore from '../cache/store.js';
import type SyncEngine from '../cache/sync-engine.js';
import type ImapService from './imap.service.js';
import MailReadService from './mail-read.service.js';

const emptyPage = { items: [], total: 0, page: 1, pageSize: 20, hasMore: false };

function createImapStub() {
  return {
    listEmails: vi.fn().mockResolvedValue(emptyPage),
    getEmail: vi.fn().mockResolvedValue({ id: '7', subject: 'hi' }),
    getEmailFlags: vi.fn().mockResolvedValue({ seen: true }),
    searchEmails: vi.fn().mockResolvedValue(emptyPage),
    getThread: vi
      .fn()
      .mockResolvedValue({ threadId: 't', messages: [], participants: [], messageCount: 0 }),
    findEmailFolder: vi.fn().mockResolvedValue({ folders: ['Archive'], messageId: '<m1@x>' }),
    downloadAttachment: vi.fn().mockResolvedValue({
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      size: 1,
      contentBase64: 'QQ==',
    }),
  };
}

function createService(stub = createImapStub()) {
  return { stub, service: new MailReadService(stub as unknown as ImapService) };
}

describe('MailReadService (pass-through)', () => {
  it('delegates listEmails with identical arguments and returns the result', async () => {
    const { stub, service } = createService();
    const options = { mailbox: 'Archive', page: 2, pageSize: 5, seen: false };

    const result = await service.listEmails('work', options);

    expect(stub.listEmails).toHaveBeenCalledExactlyOnceWith('work', options);
    expect(result).toBe(emptyPage);
  });

  it('delegates getEmail with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.getEmail('work', '42', 'Archive');

    expect(stub.getEmail).toHaveBeenCalledExactlyOnceWith('work', '42', 'Archive');
    expect(result).toEqual({ id: '7', subject: 'hi' });
  });

  it('delegates getEmailFlags with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.getEmailFlags('work', '42', 'Archive');

    expect(stub.getEmailFlags).toHaveBeenCalledExactlyOnceWith('work', '42', 'Archive');
    expect(result).toEqual({ seen: true });
  });

  it('delegates searchEmails with identical arguments and returns the result', async () => {
    const { stub, service } = createService();
    const options = { mailbox: 'INBOX', hasAttachment: true };

    const result = await service.searchEmails('work', 'invoice', options);

    expect(stub.searchEmails).toHaveBeenCalledExactlyOnceWith('work', 'invoice', options);
    expect(result).toBe(emptyPage);
  });

  it('delegates getThread with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.getThread('work', '<m1@x>', 'Archive');

    expect(stub.getThread).toHaveBeenCalledExactlyOnceWith('work', '<m1@x>', 'Archive');
    expect(result.threadId).toBe('t');
  });

  it('delegates findEmailFolder with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.findEmailFolder('work', '42', 'INBOX');

    expect(stub.findEmailFolder).toHaveBeenCalledExactlyOnceWith('work', '42', 'INBOX');
    expect(result.folders).toEqual(['Archive']);
  });

  it('delegates downloadAttachment with identical arguments and returns the result', async () => {
    const { stub, service } = createService();

    const result = await service.downloadAttachment('work', '42', 'INBOX', 'a.pdf', 1024);

    expect(stub.downloadAttachment).toHaveBeenCalledExactlyOnceWith(
      'work',
      '42',
      'INBOX',
      'a.pdf',
      1024,
    );
    expect(result.filename).toBe('a.pdf');
  });
});

// ---------------------------------------------------------------------------
// Cached read path
// ---------------------------------------------------------------------------

function seedMessages(store: CacheStore) {
  store.putMessages([
    {
      account: 'work',
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '100',
      envelope: {
        subject: 'Invoice',
        date: '2026-08-01T10:00:00.000Z',
        from: [{ name: 'Ada', address: 'ada@example.com' }],
        messageId: '<m1@example.com>',
      },
      flags: ['\\Seen', 'Work'],
      messageId: '<m1@example.com>',
      internalDate: Date.parse('2026-08-01T10:00:00Z'),
      subject: 'Invoice',
      fromText: 'Ada <ada@example.com>',
      hasAttachments: false,
    },
    {
      account: 'work',
      mailbox: 'INBOX',
      uid: 2,
      uidValidity: '100',
      envelope: {
        subject: 'Lunch',
        date: '2026-08-02T10:00:00.000Z',
        from: [{ address: 'bob@example.com' }],
        messageId: '<m2@example.com>',
      },
      flags: [],
      messageId: '<m2@example.com>',
      internalDate: Date.parse('2026-08-02T10:00:00Z'),
      subject: 'Lunch',
      fromText: 'bob@example.com',
      hasAttachments: false,
    },
  ]);
}

function seedState(store: CacheStore, lastSyncedAt: number) {
  store.putMailboxState({
    account: 'work',
    mailbox: 'INBOX',
    uidValidity: '100',
    uidNext: 3,
    syncTier: 'baseline',
    totalMessages: 2,
    lastSyncedAt,
  });
}

function createEngineStub() {
  return {
    syncMailbox: vi.fn().mockResolvedValue({
      ok: true,
      account: 'work',
      mailbox: 'INBOX',
      stored: 0,
      removed: 0,
      epochReset: false,
    }),
    isDirty: vi.fn().mockReturnValue(false),
  };
}

function createCachedSetup(options: { lastSyncedAt?: number; syncWaitMs?: number } = {}) {
  const store = new CacheStore(':memory:');
  seedMessages(store);
  seedState(store, options.lastSyncedAt ?? Date.now());
  const stub = createImapStub();
  const imap = {
    ...stub,
    getMailboxStatus: vi.fn().mockResolvedValue({ uidValidity: '100', uidNext: 3, messages: 2 }),
  };
  const engine = createEngineStub();
  const service = new MailReadService(
    imap as unknown as ImapService,
    store,
    engine as unknown as SyncEngine,
    { syncWaitMs: options.syncWaitMs ?? 50 },
  );
  return { store, imap, engine, service };
}

describe('MailReadService (cached reads)', () => {
  it('serves a fresh mirror without touching the network', async () => {
    const { imap, engine, service } = createCachedSetup();

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.items.map((m) => m.id)).toEqual(['2', '1']);
    expect(result.total).toBe(2);
    expect(result.cache).toEqual({ source: 'cache' });
    expect(imap.listEmails).not.toHaveBeenCalled();
    expect(imap.getMailboxStatus).not.toHaveBeenCalled();
    expect(engine.syncMailbox).not.toHaveBeenCalled();
  });

  it('maps cached rows to the live EmailMeta shape', async () => {
    const { service } = createCachedSetup();

    const { items } = await service.listEmails('work', { mailbox: 'INBOX' });
    const invoice = items.find((m) => m.id === '1');

    expect(invoice).toMatchObject({
      id: '1',
      subject: 'Invoice',
      from: { name: 'Ada', address: 'ada@example.com' },
      date: '2026-08-01T10:00:00.000Z',
      seen: true,
      flagged: false,
      answered: false,
      labels: ['Work'],
    });
  });

  it('applies filters to the cached listing', async () => {
    const { service } = createCachedSetup();

    const result = await service.listEmails('work', { mailbox: 'INBOX', seen: false });

    expect(result.items.map((m) => m.id)).toEqual(['2']);
    expect(result.total).toBe(1);
  });

  it('revalidates with one STATUS once the debounce has passed', async () => {
    const { imap, engine, service, store } = createCachedSetup({
      lastSyncedAt: Date.now() - 60_000,
    });

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.cache).toEqual({ source: 'cache' });
    expect(imap.getMailboxStatus).toHaveBeenCalledExactlyOnceWith('work', 'INBOX');
    expect(engine.syncMailbox).not.toHaveBeenCalled();
    expect(imap.listEmails).not.toHaveBeenCalled();
    // The confirmation counts as a sync for debounce purposes.
    expect(store.getMailboxState('work', 'INBOX')?.lastSyncedAt).toBeGreaterThan(
      Date.now() - 5_000,
    );
  });

  it('syncs before serving when STATUS reports a change', async () => {
    const { imap, engine, service } = createCachedSetup({ lastSyncedAt: Date.now() - 60_000 });
    imap.getMailboxStatus.mockResolvedValue({ uidValidity: '100', uidNext: 7, messages: 3 });

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(engine.syncMailbox).toHaveBeenCalledExactlyOnceWith('work', 'INBOX');
    expect(result.cache).toEqual({ source: 'cache' });
  });

  it('treats an uncomparable STATUS as changed', async () => {
    const { imap, engine, service } = createCachedSetup({ lastSyncedAt: Date.now() - 60_000 });
    // A server that reports none of the comparable fields gives no evidence
    // the mirror is current — that must trigger a sync, never a cache hit.
    imap.getMailboxStatus.mockResolvedValue({});

    await service.listEmails('work', { mailbox: 'INBOX' });

    expect(engine.syncMailbox).toHaveBeenCalled();
  });

  it('serves stale with a marker when the sync exceeds the bounded wait', async () => {
    const { imap, engine, service } = createCachedSetup({
      lastSyncedAt: Date.now() - 60_000,
      syncWaitMs: 5,
    });
    imap.getMailboxStatus.mockResolvedValue({ uidValidity: '100', uidNext: 7, messages: 3 });
    engine.syncMailbox.mockReturnValue(new Promise(() => {}));

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.cache).toEqual({ source: 'cache', stale: true });
    expect(result.items).toHaveLength(2);
  });

  it('serves the mirror flagged offline when IMAP is unreachable', async () => {
    const { imap, service } = createCachedSetup({ lastSyncedAt: Date.now() - 60_000 });
    imap.getMailboxStatus.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.cache).toEqual({ source: 'cache', offline: true });
    expect(result.items).toHaveLength(2);
    expect(imap.listEmails).not.toHaveBeenCalled();
  });

  it('flags the result offline when the awaited sync fails', async () => {
    const { imap, engine, service } = createCachedSetup({ lastSyncedAt: Date.now() - 60_000 });
    imap.getMailboxStatus.mockResolvedValue({ uidValidity: '100', uidNext: 7, messages: 3 });
    engine.syncMailbox.mockResolvedValue({
      ok: false,
      account: 'work',
      mailbox: 'INBOX',
      stored: 0,
      removed: 0,
      epochReset: false,
      error: 'ECONNRESET',
    });

    const result = await service.listEmails('work', { mailbox: 'INBOX' });

    expect(result.cache).toEqual({ source: 'cache', offline: true });
  });

  it('falls back to live for a mailbox the mirror has never synced', async () => {
    const { imap, engine, service } = createCachedSetup();

    const result = await service.listEmails('work', { mailbox: 'Archive' });

    expect(imap.listEmails).toHaveBeenCalledExactlyOnceWith('work', { mailbox: 'Archive' });
    expect(result.cache).toBeUndefined();
    // The read warms the mirror for next time.
    expect(engine.syncMailbox).toHaveBeenCalledExactlyOnceWith('work', 'Archive');
  });

  it('bypasses the debounce when the mailbox is dirty', async () => {
    const { engine, service } = createCachedSetup({ lastSyncedAt: Date.now() });
    engine.isDirty.mockReturnValue(true);

    await service.listEmails('work', { mailbox: 'INBOX' });

    expect(engine.syncMailbox).toHaveBeenCalledExactlyOnceWith('work', 'INBOX');
  });

  it('serves email flags from the mirror', async () => {
    const { imap, service } = createCachedSetup();

    const flags = await service.getEmailFlags('work', '1', 'INBOX');

    expect(flags).toMatchObject({
      seen: true,
      flagged: false,
      answered: false,
      labels: ['Work'],
      subject: 'Invoice',
      from: 'Ada <ada@example.com>',
    });
    expect(imap.getEmailFlags).not.toHaveBeenCalled();
  });

  it('falls back to live flags when the message is not mirrored', async () => {
    const { imap, service } = createCachedSetup();

    await service.getEmailFlags('work', '999', 'INBOX');

    expect(imap.getEmailFlags).toHaveBeenCalledExactlyOnceWith('work', '999', 'INBOX');
  });
});

describe('MailReadService (cached bodies)', () => {
  function fullLiveEmail(body: Partial<Record<string, unknown>> = {}) {
    return {
      id: '1',
      subject: 'Invoice',
      from: { name: 'Ada', address: 'ada@example.com' },
      to: [],
      date: '2026-08-01T10:00:00.000Z',
      seen: true,
      flagged: false,
      answered: false,
      hasAttachments: false,
      labels: ['Work'],
      cc: [],
      bcc: [],
      bodyText: 'fresh body',
      messageId: '<m1@example.com>',
      attachments: [],
      headers: { subject: 'Invoice' },
      ...body,
    };
  }

  it('serves a fully cached message without touching the network', async () => {
    const { store, imap, service } = createCachedSetup();
    store.putBody('work', 'INBOX', 1, '100', {
      text: 'Anbei die Rechnung.',
      subtype: 'plain',
      headers: { subject: 'Invoice', references: '<r1@x> <r2@x>' },
      preview: 'Anbei die Rechnung.',
    });

    const email = await service.getEmail('work', '1', 'INBOX');

    expect(imap.getEmail).not.toHaveBeenCalled();
    expect(email).toMatchObject({
      id: '1',
      subject: 'Invoice',
      from: { name: 'Ada', address: 'ada@example.com' },
      seen: true,
      labels: ['Work'],
      bodyText: 'Anbei die Rechnung.',
      messageId: '<m1@example.com>',
      references: ['<r1@x>', '<r2@x>'],
      headers: { subject: 'Invoice', references: '<r1@x> <r2@x>' },
    });
    expect(email.bodyHtml).toBeUndefined();
    expect(email.attachments).toEqual([]);
    expect(store.getMessage('work', 'INBOX', 1, '100')?.lastAccessedAt).toBeDefined();
  });

  it('maps a cached html body to bodyHtml', async () => {
    const { store, service } = createCachedSetup();
    store.putBody('work', 'INBOX', 2, '100', {
      text: '<p>Hi</p>',
      subtype: 'html',
      headers: {},
    });

    const email = await service.getEmail('work', '2', 'INBOX');

    expect(email.bodyHtml).toBe('<p>Hi</p>');
    expect(email.bodyText).toBeUndefined();
  });

  it('fetches live on a body miss and persists the result for the next read', async () => {
    const { store, imap, service } = createCachedSetup();
    imap.getEmail.mockResolvedValue(fullLiveEmail());

    const first = await service.getEmail('work', '1', 'INBOX');
    expect(first.bodyText).toBe('fresh body');
    expect(imap.getEmail).toHaveBeenCalledTimes(1);

    const row = store.getMessage('work', 'INBOX', 1, '100');
    expect(row?.bodyText).toBe('fresh body');
    expect(row?.headers).toEqual({ subject: 'Invoice' });
    expect(row?.preview).toBe('fresh body');

    const second = await service.getEmail('work', '1', 'INBOX');
    expect(imap.getEmail).toHaveBeenCalledTimes(1);
    expect(second.bodyText).toBe('fresh body');
  });

  it('does not persist an oversized body and does not retry it in backfill', async () => {
    const { store, imap, service } = createCachedSetup();
    imap.getEmail.mockResolvedValue(fullLiveEmail({ bodyText: 'x'.repeat(300 * 1024) }));

    await service.getEmail('work', '1', 'INBOX');

    const row = store.getMessage('work', 'INBOX', 1, '100');
    expect(row?.bodyText).toBeUndefined();
    expect(store.listMissingBodies('work', 'INBOX', '100', 10)).not.toContain(1);
  });

  it('coalesces concurrent fetches of the same message', async () => {
    const { imap, service } = createCachedSetup();
    imap.getEmail.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(fullLiveEmail()), 5)),
    );

    const [a, b] = await Promise.all([
      service.getEmail('work', '1', 'INBOX'),
      service.getEmail('work', '1', 'INBOX'),
    ]);

    expect(imap.getEmail).toHaveBeenCalledTimes(1);
    expect(a.bodyText).toBe('fresh body');
    expect(b.bodyText).toBe('fresh body');
  });
});
