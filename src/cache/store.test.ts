import CacheStore from './store.js';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    account: 'work',
    mailbox: 'INBOX',
    uid: 1,
    uidValidity: '100',
    envelope: { subject: 'Hello' },
    flags: ['\\Seen'],
    messageId: '<a@example.com>',
    internalDate: Date.parse('2026-08-01T10:00:00Z'),
    subject: 'Hello',
    fromText: 'Ada <ada@example.com>',
    hasAttachments: false,
    ...overrides,
  };
}

describe('CacheStore', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('messages', () => {
    it('round-trips a message', () => {
      store.putMessages([makeMessage()]);

      const found = store.getMessage('work', 'INBOX', 1, '100');

      expect(found).toMatchObject({
        uid: 1,
        subject: 'Hello',
        flags: ['\\Seen'],
        messageId: '<a@example.com>',
      });
    });

    it('returns undefined for a message from a different UIDVALIDITY', () => {
      store.putMessages([makeMessage({ uidValidity: '100' })]);

      // Same UID, new epoch — this is a different message entirely.
      expect(store.getMessage('work', 'INBOX', 1, '999')).toBeUndefined();
    });

    it('upserts rather than duplicating on re-sync', () => {
      store.putMessages([makeMessage({ flags: ['\\Seen'] })]);
      store.putMessages([makeMessage({ flags: ['\\Seen', '\\Flagged'] })]);

      expect(store.getMessage('work', 'INBOX', 1, '100')?.flags).toEqual(['\\Seen', '\\Flagged']);
      expect(store.countMessages('work', 'INBOX')).toBe(1);
    });

    it('preserves an already-fetched body when re-syncing metadata', () => {
      store.putMessages([makeMessage()]);
      store.putBody('work', 'INBOX', 1, '100', { text: 'the full body text' });

      // A metadata resync (e.g. a flag change) must not wipe the body and
      // force another download.
      store.putMessages([makeMessage({ flags: ['\\Seen', '\\Flagged'] })]);

      expect(store.getMessage('work', 'INBOX', 1, '100')?.bodyText).toBe('the full body text');
    });
  });

  describe('pagination', () => {
    beforeEach(() => {
      const base = Date.parse('2026-08-01T10:00:00Z');
      store.putMessages(
        Array.from({ length: 25 }, (_, i) =>
          makeMessage({
            uid: i + 1,
            subject: `Message ${i + 1}`,
            messageId: `<${i + 1}@example.com>`,
            // Ascending dates, so the newest is uid 25.
            internalDate: base + i * 60_000,
          }),
        ),
      );
    });

    it('returns newest first', () => {
      const page = store.listMessages('work', 'INBOX', '100', { page: 1, pageSize: 5 });

      expect(page.items.map((m) => m.uid)).toEqual([25, 24, 23, 22, 21]);
      expect(page.total).toBe(25);
      expect(page.hasMore).toBe(true);
    });

    it('pages deeper without rescanning', () => {
      const page = store.listMessages('work', 'INBOX', '100', { page: 5, pageSize: 5 });

      expect(page.items.map((m) => m.uid)).toEqual([5, 4, 3, 2, 1]);
      expect(page.hasMore).toBe(false);
    });
  });

  describe('full-text search', () => {
    it('finds a message by body text', () => {
      store.putMessages([makeMessage({ uid: 1, subject: 'Rechnung' })]);
      store.putBody('work', 'INBOX', 1, '100', { text: 'Anbei die Rechnung für August.' });

      const hits = store.searchMessages('work', 'INBOX', '100', 'Rechnung');

      expect(hits.map((m) => m.uid)).toEqual([1]);
    });

    it('does not return a message after it is purged', () => {
      store.putMessages([makeMessage({ uid: 1 })]);
      store.putBody('work', 'INBOX', 1, '100', { text: 'findable text' });
      store.deleteMessages('work', 'INBOX', [1], '100');

      // A stale FTS index would still match here — the triggers must keep the
      // index and the table in step.
      expect(store.searchMessages('work', 'INBOX', '100', 'findable')).toEqual([]);
    });
  });

  describe('mailbox state', () => {
    it('round-trips watermarks including 64-bit values', () => {
      // Beyond Number.MAX_SAFE_INTEGER: must survive as an exact string.
      const bigModseq = '9223372036854775807';
      store.putMailboxState({
        account: 'work',
        mailbox: 'INBOX',
        uidValidity: '100',
        uidNext: 42,
        highestModseq: bigModseq,
        syncTier: 'qresync',
      });

      const state = store.getMailboxState('work', 'INBOX');

      expect(state?.highestModseq).toBe(bigModseq);
      expect(state?.uidNext).toBe(42);
      expect(state?.syncTier).toBe('qresync');
    });

    it('purges every message of the old epoch when UIDVALIDITY changes', () => {
      store.putMailboxState({
        account: 'work',
        mailbox: 'INBOX',
        uidValidity: '100',
        syncTier: 'baseline',
      });
      store.putMessages([makeMessage({ uid: 1 }), makeMessage({ uid: 2 })]);

      const purged = store.resetEpoch('work', 'INBOX', '200');

      expect(purged).toBe(2);
      expect(store.countMessages('work', 'INBOX')).toBe(0);
      expect(store.getMailboxState('work', 'INBOX')?.uidValidity).toBe('200');
    });

    it('leaves other mailboxes untouched when one epoch resets', () => {
      store.putMessages([
        makeMessage({ uid: 1, mailbox: 'INBOX' }),
        makeMessage({ uid: 1, mailbox: 'Archive' }),
      ]);

      store.resetEpoch('work', 'INBOX', '200');

      expect(store.countMessages('work', 'Archive')).toBe(1);
    });
  });
});

describe('attachment names', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('round-trips attachment names', () => {
    store.putMessages([
      makeMessage({ hasAttachments: true, attachmentNames: ['Q3 report.pdf', 'invoice.xlsx'] }),
    ]);

    expect(store.getMessage('work', 'INBOX', 1, '100')?.attachmentNames).toEqual([
      'Q3 report.pdf',
      'invoice.xlsx',
    ]);
  });

  it('returns an empty list when a message has no attachments', () => {
    store.putMessages([makeMessage()]);

    expect(store.getMessage('work', 'INBOX', 1, '100')?.attachmentNames).toEqual([]);
  });

  it('finds messages by attachment filename via full-text search', () => {
    store.putMessages([
      makeMessage({
        uid: 1,
        subject: 'Quarterly numbers',
        hasAttachments: true,
        attachmentNames: ['Q3 report.pdf'],
      }),
      makeMessage({ uid: 2, subject: 'Lunch plans' }),
    ]);

    const hits = store.searchMessages('work', 'INBOX', '100', 'report');

    expect(hits.map((h) => h.uid)).toEqual([1]);
  });
});

describe('schema v3: flag columns and filtered listing', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(':memory:');
    const base = Date.parse('2026-08-01T10:00:00Z');
    store.putMessages([
      makeMessage({
        uid: 1,
        subject: 'Invoice August',
        fromText: 'Ada <ada@example.com>',
        flags: ['\\Seen'],
        internalDate: base,
      }),
      makeMessage({
        uid: 2,
        subject: 'Lunch plans',
        fromText: 'Bob <bob@example.com>',
        flags: [],
        hasAttachments: true,
        internalDate: base + 60_000,
      }),
      makeMessage({
        uid: 3,
        subject: 'Re: Invoice August',
        fromText: 'Ada <ada@example.com>',
        flags: ['\\Seen', '\\Flagged', '\\Answered'],
        internalDate: base + 120_000,
      }),
    ]);
  });

  afterEach(() => {
    store.close();
  });

  function uids(filters: Parameters<CacheStore['listMessages']>[4]): number[] {
    return store
      .listMessages('work', 'INBOX', '100', { page: 1, pageSize: 10 }, filters)
      .items.map((m) => m.uid);
  }

  it('filters by seen state', () => {
    expect(uids({ seen: false })).toEqual([2]);
    expect(uids({ seen: true })).toEqual([3, 1]);
  });

  it('filters by flagged and answered state', () => {
    expect(uids({ flagged: true })).toEqual([3]);
    expect(uids({ answered: false })).toEqual([2, 1]);
  });

  it('filters by attachment presence', () => {
    expect(uids({ hasAttachment: true })).toEqual([2]);
    expect(uids({ hasAttachment: false })).toEqual([3, 1]);
  });

  it('filters by sender and subject substring', () => {
    expect(uids({ from: 'ada@example' })).toEqual([3, 1]);
    expect(uids({ subject: 'invoice' })).toEqual([3, 1]);
  });

  it('filters by date range', () => {
    expect(uids({ since: '2026-08-01T10:01:00Z' })).toEqual([3, 2]);
    expect(uids({ before: '2026-08-01T10:01:00Z' })).toEqual([1]);
  });

  it('escapes LIKE wildcards in substring filters', () => {
    expect(uids({ subject: '%' })).toEqual([]);
  });

  it('exposes the flag state on the read model', () => {
    const msg = store.getMessage('work', 'INBOX', 3, '100');
    expect(msg).toMatchObject({ seen: true, flagged: true, answered: true });
  });

  it('updates flags and filterable columns via applyFlags', () => {
    store.applyFlags('work', 'INBOX', 2, '100', ['\\Seen']);

    expect(store.getMessage('work', 'INBOX', 2, '100')?.flags).toEqual(['\\Seen']);
    expect(uids({ seen: false })).toEqual([]);
    // The FTS triggers fire on UPDATE — the index must stay consistent.
    expect(store.searchMessages('work', 'INBOX', '100', 'lunch').map((m) => m.uid)).toEqual([2]);
  });

  it('reconciles swept flags, touching only rows that changed', () => {
    const updated = store.reconcileFlags('work', 'INBOX', '100', [
      { uid: 1, flags: ['\\Seen'] }, // unchanged
      { uid: 2, flags: ['\\Flagged'] }, // changed
      { uid: 99, flags: ['\\Seen'] }, // not mirrored — ignored
    ]);

    expect(updated).toBe(1);
    const msg = store.getMessage('work', 'INBOX', 2, '100');
    expect(msg?.flags).toEqual(['\\Flagged']);
    expect(msg?.flagged).toBe(true);
  });

  it('treats flag order as irrelevant when deciding whether a row changed', () => {
    store.putMessages([makeMessage({ uid: 7, flags: ['\\Seen', '\\Flagged'] })]);

    const updated = store.reconcileFlags('work', 'INBOX', '100', [
      { uid: 7, flags: ['\\Flagged', '\\Seen'] },
    ]);

    expect(updated).toBe(0);
  });

  it('round-trips a stable email id', () => {
    store.putMessages([makeMessage({ uid: 9, emailId: 'em-123' })]);

    expect(store.getMessage('work', 'INBOX', 9, '100')?.emailId).toBe('em-123');
  });
});

describe('schema v3: body tier plumbing', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(':memory:');
    store.putMessages([makeMessage({ uid: 1 }), makeMessage({ uid: 2 }), makeMessage({ uid: 3 })]);
  });

  afterEach(() => {
    store.close();
  });

  it('stores body text with subtype, headers and preview', () => {
    store.putBody('work', 'INBOX', 1, '100', {
      text: '<p>Hello</p>',
      subtype: 'html',
      headers: { 'content-type': 'text/html' },
      preview: 'Hello',
    });

    const msg = store.getMessage('work', 'INBOX', 1, '100');
    expect(msg?.bodyText).toBe('<p>Hello</p>');
    expect(msg?.bodySubtype).toBe('html');
    expect(msg?.headers).toEqual({ 'content-type': 'text/html' });
    expect(msg?.preview).toBe('Hello');
    expect(msg?.bodyFetchedAt).toBeDefined();
  });

  it('preserves body, preview and headers across a metadata resync', () => {
    store.putBody('work', 'INBOX', 1, '100', {
      text: 'the body',
      preview: 'the preview',
      headers: { subject: 'Hello' },
    });

    // A flag-change resync re-upserts the row; downloaded content must stay.
    store.putMessages([makeMessage({ uid: 1, flags: ['\\Seen', '\\Flagged'] })]);

    const msg = store.getMessage('work', 'INBOX', 1, '100');
    expect(msg?.bodyText).toBe('the body');
    expect(msg?.preview).toBe('the preview');
    expect(msg?.headers).toEqual({ subject: 'Hello' });
  });

  it('lists messages still missing bodies, newest first', () => {
    store.putBody('work', 'INBOX', 2, '100', { text: 'cached' });

    expect(store.listMissingBodies('work', 'INBOX', '100', 10)).toEqual([3, 1]);
    expect(store.listMissingBodies('work', 'INBOX', '100', 1)).toEqual([3]);
  });

  it('records read access for LRU eviction', () => {
    store.touchAccess('work', 'INBOX', '100', [1, 2]);

    expect(store.getMessage('work', 'INBOX', 1, '100')?.lastAccessedAt).toBeDefined();
    expect(store.getMessage('work', 'INBOX', 3, '100')?.lastAccessedAt).toBeUndefined();
  });

  it('reports per-mailbox statistics', () => {
    store.putMailboxState({
      account: 'work',
      mailbox: 'INBOX',
      uidValidity: '100',
      syncTier: 'baseline',
      totalMessages: 3,
    });
    store.putBody('work', 'INBOX', 1, '100', { text: 'cached' });

    const stats = store.getStats();

    expect(stats.messageCount).toBe(3);
    expect(stats.bodyCount).toBe(1);
    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.mailboxes).toEqual([
      expect.objectContaining({
        account: 'work',
        mailbox: 'INBOX',
        syncTier: 'baseline',
        cachedMessages: 3,
        bodiesCached: 1,
      }),
    ]);
  });
});

describe('schema v3: durability pragmas', () => {
  it('creates new database files with incremental auto-vacuum', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dbPath = join(mkdtempSync(join(tmpdir(), 'cache-store-')), 'mirror.sqlite');
    const store = new CacheStore(dbPath);
    store.close();

    // auto_vacuum is persisted in the file header; it only takes effect when
    // set before the first table is created, so this proves the ordering.
    const raw = new DatabaseSync(dbPath);
    const { auto_vacuum: autoVacuum } = raw.prepare('PRAGMA auto_vacuum').get() as {
      auto_vacuum: number;
    };
    raw.close();

    expect(autoVacuum).toBe(2);
  });
});

describe('schema migration', () => {
  it('rebuilds the mirror when the on-disk schema version differs', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dbPath = join(mkdtempSync(join(tmpdir(), 'cache-store-')), 'mirror.sqlite');
    const first = new CacheStore(dbPath);
    first.putMessages([makeMessage()]);
    first.close();

    // Simulate a file written by an older build.
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 0');
    raw.close();

    const reopened = new CacheStore(dbPath);
    expect(reopened.countMessages('work', 'INBOX')).toBe(0);
    reopened.close();
  });
});

describe('schema v3: body backfill bookkeeping', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(':memory:');
    store.putMessages([makeMessage({ uid: 1 }), makeMessage({ uid: 2 })]);
  });

  afterEach(() => {
    store.close();
  });

  it('stops offering a message once a body fetch was attempted', () => {
    store.markBodyAttempted('work', 'INBOX', 1, '100');

    expect(store.listMissingBodies('work', 'INBOX', '100', 10)).toEqual([2]);
    // The attempt marker must not fabricate a body.
    expect(store.getMessage('work', 'INBOX', 1, '100')?.bodyText).toBeUndefined();
  });

  it('counts cached bodies per mailbox generation', () => {
    expect(store.countBodies('work', 'INBOX', '100')).toBe(0);

    store.putBody('work', 'INBOX', 1, '100', { text: 'hello' });

    expect(store.countBodies('work', 'INBOX', '100')).toBe(1);
  });
});
