/**
 * Integration: the cached read path against a real IMAP server.
 *
 * GreenMail advertises neither CONDSTORE nor QRESYNC, so this exercises the
 * baseline tier — the hardest case for cache correctness: no modseq, deletions
 * and flag changes invisible to STATUS, every freshness decision resting on
 * the facade's protocol (STATUS compare + dirty tracking + UID-set diff).
 */

import CacheStore from '../cache/store.js';
import SyncEngine from '../cache/sync-engine.js';
import MailReadService from '../services/mail-read.service.js';
import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Cached read path (MailReadService + SyncEngine)', () => {
  let services: TestServices;
  let store: CacheStore;
  let engine: SyncEngine;
  let mailRead: MailReadService;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    store = new CacheStore(':memory:');
    engine = new SyncEngine(services.connections, store, { bodyMessages: 100 });
    engine.start();
    // debounceMs 0: every read revalidates, so the assertions below test the
    // protocol rather than the debounce shortcut.
    mailRead = new MailReadService(services.imapService, store, engine, { debounceMs: 0 });

    await seedEmail({ subject: 'Cached one' });
    await waitForDelivery();
    await engine.syncMailbox(TEST_ACCOUNT_NAME, 'INBOX');
  });

  afterAll(async () => {
    engine.stop();
    store.close();
    await services.connections.closeAll();
  });

  it('serves a synced mailbox from the mirror', async () => {
    const result = await mailRead.listEmails(TEST_ACCOUNT_NAME, { mailbox: 'INBOX' });

    expect(result.cache?.source).toBe('cache');
    expect(result.items.some((m) => m.subject === 'Cached one')).toBe(true);
  });

  it('sees mail that arrived after the last sync via STATUS revalidation', async () => {
    await seedEmail({ subject: 'Arrived later' });
    await waitForDelivery();

    const result = await mailRead.listEmails(TEST_ACCOUNT_NAME, { mailbox: 'INBOX' });

    expect(result.cache?.source).toBe('cache');
    expect(result.items.some((m) => m.subject === 'Arrived later')).toBe(true);
  });

  it('serves a repeat get_email from the mirror without re-downloading the body', async () => {
    const listing = await mailRead.listEmails(TEST_ACCOUNT_NAME, { mailbox: 'INBOX' });
    const target = listing.items.find((m) => m.subject === 'Cached one');
    if (!target) throw new Error('seeded message not found in cached listing');

    const first = await mailRead.getEmail(TEST_ACCOUNT_NAME, target.id, 'INBOX');
    expect(first.bodyText ?? first.bodyHtml).toBeTruthy();

    const client = await services.connections.getImapClient(TEST_ACCOUNT_NAME);
    const download = vi.spyOn(client, 'download');
    const fetchOne = vi.spyOn(client, 'fetchOne');

    const second = await mailRead.getEmail(TEST_ACCOUNT_NAME, target.id, 'INBOX');

    expect(download).not.toHaveBeenCalled();
    expect(fetchOne).not.toHaveBeenCalled();
    expect(second.bodyText).toBe(first.bodyText);
    expect(second.headers).toEqual(first.headers);
    expect(second.messageId).toBe(first.messageId);
    download.mockRestore();
    fetchOne.mockRestore();
  });

  it('backfills bodies into the mirror so search gains full-text coverage', async () => {
    await seedEmail({ subject: 'Backfill target', text: 'Das Geheimwort ist Nebelkraehe.' });
    await waitForDelivery();
    await engine.syncMailbox(TEST_ACCOUNT_NAME, 'INBOX');

    const stored = await engine.backfillBodies(TEST_ACCOUNT_NAME, 'INBOX');
    expect(stored).toBeGreaterThan(0);

    const state = store.getMailboxState(TEST_ACCOUNT_NAME, 'INBOX');
    if (!state) throw new Error('mailbox state missing after sync');
    const hits = store.searchMessages(TEST_ACCOUNT_NAME, 'INBOX', state.uidValidity, 'Nebelkraehe');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('reflects a local flag write immediately on a server without CONDSTORE', async () => {
    const listing = await mailRead.listEmails(TEST_ACCOUNT_NAME, { mailbox: 'INBOX' });
    const target = listing.items.find((m) => m.subject === 'Cached one');
    if (!target) throw new Error('seeded message not found in cached listing');
    expect(target.flagged).toBe(false);

    // STATUS cannot reveal a flag-only change on this server; only the
    // write-through email:changed event makes the next read correct.
    await services.imapService.setFlags(TEST_ACCOUNT_NAME, target.id, 'INBOX', 'flag');

    const flags = await mailRead.getEmailFlags(TEST_ACCOUNT_NAME, target.id, 'INBOX');
    expect(flags.flagged).toBe(true);

    const relisted = await mailRead.listEmails(TEST_ACCOUNT_NAME, { mailbox: 'INBOX' });
    expect(relisted.items.find((m) => m.id === target.id)?.flagged).toBe(true);
  });
});
