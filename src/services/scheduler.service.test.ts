import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SCHEDULED_DIR resolves from XDG state at module load — point it at a
// throwaway directory before the service (and its xdg import) are loaded.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'sched-'));
process.env.XDG_STATE_HOME = STATE_HOME;

// Every run would otherwise leave a queue directory, and now its claim files,
// behind in the system temp dir.
afterAll(() => {
  rmSync(STATE_HOME, { recursive: true, force: true });
});

const { default: SchedulerService } = await import('./scheduler.service.js');

import type ImapService from './imap.service.js';
import type SmtpService from './smtp.service.js';

const SCHEDULED_DIR = join(STATE_HOME, 'email-mcp', 'scheduled');

function mocks(sendImpl?: () => Promise<{ messageId: string; status: string }>) {
  const smtp = {
    sendEmail: sendImpl
      ? vi.fn().mockImplementation(sendImpl)
      : vi.fn().mockResolvedValue({ messageId: '<sent@x>', status: 'sent' }),
  };
  const imap = {
    saveDraft: vi.fn().mockResolvedValue({ id: 1, mailbox: 'Drafts' }),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
  };
  return {
    smtp,
    imap,
    svc: new SchedulerService(smtp as unknown as SmtpService, imap as unknown as ImapService),
  };
}

/** Write a due queue entry straight to disk, bypassing the future-date guard. */
async function queueDue(
  fsp: typeof import('node:fs/promises'),
  id: string,
  overrides: Record<string, unknown> = {},
  suffix = '',
): Promise<string> {
  await fsp.mkdir(SCHEDULED_DIR, { recursive: true });
  const entry = {
    id,
    account: 'test',
    to: ['a@b.c'],
    subject: 'Deferred',
    body: 'body',
    html: false,
    sendAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
  const file = join(SCHEDULED_DIR, `${id}.json${suffix}`);
  await fsp.writeFile(file, JSON.stringify(entry, null, 2));
  return file;
}

describe('SchedulerService dispatch', () => {
  it('passes inReplyTo and references through to sendEmail', async () => {
    // A scheduled reply persisted its threading headers but the dispatch
    // dropped them — the sent message silently fell out of its thread.
    const smtp = {
      sendEmail: vi.fn().mockResolvedValue({ messageId: '<sent@x>', status: 'sent' }),
    };
    const imap = {
      saveDraft: vi.fn().mockResolvedValue({ id: 1, mailbox: 'Drafts' }),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new SchedulerService(
      smtp as unknown as SmtpService,
      imap as unknown as ImapService,
    );

    await svc.schedule('test', {
      to: ['a@b.c'],
      subject: 'Re: hi',
      body: 'later',
      sendAt: new Date(Date.now() + 20).toISOString(),
      inReplyTo: '<orig@x>',
      references: ['<root@x>', '<orig@x>'],
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    await svc.checkAndSend();

    expect(smtp.sendEmail).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({
        inReplyTo: '<orig@x>',
        references: ['<root@x>', '<orig@x>'],
      }),
    );
  });
});

describe('SchedulerService claim safety', () => {
  let fsp: typeof import('node:fs/promises');

  beforeAll(async () => {
    fsp = await import('node:fs/promises');
  });

  afterEach(async () => {
    await fsp.rm(SCHEDULED_DIR, { recursive: true, force: true });
  });

  it('sends once when two runners sweep the queue concurrently', async () => {
    // The in-process interval and the launchd/cron daemon both poll the same
    // directory. Under the old read-then-write lock both could observe
    // 'pending' before either wrote 'sending', and the mail went out twice.
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { smtp, svc } = mocks(async () => {
      // Hold the first send open so the second runner sweeps mid-flight.
      await inFlight;
      return { messageId: '<sent@x>', status: 'sent' };
    });
    await queueDue(fsp, 'race-1');

    const first = svc.checkAndSend();
    const second = svc.checkAndSend();
    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
    expect(a.sent + b.sent).toBe(1);
  });

  it('leaves a freshly claimed entry alone instead of stealing it', async () => {
    const { smtp, svc } = mocks();
    await queueDue(
      fsp,
      'fresh-claim',
      { status: 'sending', claimedAt: new Date().toISOString(), attempts: 1 },
      '.claim',
    );

    await svc.checkAndSend();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
  });

  it('requeues a stale claim that never reached SMTP', async () => {
    const { smtp, svc } = mocks();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await queueDue(
      fsp,
      'stale-pre',
      { status: 'sending', claimedAt: stale, attempts: 1 },
      '.claim',
    );

    await svc.checkAndSend();

    // No sendStartedAt means the previous runner died before handing it over,
    // so resending is safe and expected.
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('fails a stale claim that had already reached SMTP rather than resending it', async () => {
    const { smtp, svc } = mocks();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await queueDue(
      fsp,
      'stale-mid',
      { status: 'sending', claimedAt: stale, sendStartedAt: stale, attempts: 1 },
      '.claim',
    );

    const result = await svc.checkAndSend();

    // Delivery is unknown here. Mailing a client twice is worse than a
    // visible failure the user can resolve.
    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    const entry = JSON.parse(
      await fsp.readFile(join(SCHEDULED_DIR, 'stale-mid.json'), 'utf-8'),
    ) as { status: string; lastError: string };
    expect(entry.status).toBe('failed');
    expect(entry.lastError).toMatch(/delivery status unknown/i);
  });

  it('finishes the move for a stale claim that was already delivered', async () => {
    // Delivery is recorded on the claim before it moves, so a crash in that
    // window leaves proof the message went out. Reporting it failed would be
    // the mirror of the double-send bug: quieter, and still wrong.
    const { smtp, svc } = mocks();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await queueDue(
      fsp,
      'delivered',
      {
        status: 'sent',
        claimedAt: stale,
        sendStartedAt: stale,
        sentAt: stale,
        sentMessageId: '<already@sent>',
        attempts: 1,
      },
      '.claim',
    );

    const result = await svc.checkAndSend();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect(result.failed).toBe(0);
    // It belongs in the sent directory, and must not linger in the queue.
    const sent = await svc.list({ status: 'sent' });
    expect(sent.map((e) => e.id)).toContain('delivered');
    const queued = await svc.list({ status: 'all' });
    expect(queued.filter((e) => e.id === 'delivered')).toHaveLength(1);
  });

  it('shows a delivered entry that has not finished moving yet', async () => {
    // The outcome is written before the move, so for an instant a delivered
    // entry sits in the queue directory marked sent. Filtering by directory
    // rather than by the status field hid it from the 'sent' listing (wrong
    // directory) and from 'pending' (wrong status) at once — invisible in
    // both, exactly when a user asks whether their mail went out.
    const { svc } = mocks();
    await queueDue(
      fsp,
      'mid-move',
      {
        status: 'sent',
        claimedAt: new Date().toISOString(),
        sendStartedAt: new Date().toISOString(),
        sentMessageId: '<mid@move>',
      },
      '.claim',
    );

    const sent = await svc.list({ status: 'sent' });
    expect(sent.map((e) => e.id)).toContain('mid-move');

    // And it is not double-counted once both directories are read.
    const all = await svc.list({ status: 'all' });
    expect(all.filter((e) => e.id === 'mid-move')).toHaveLength(1);

    // It is not pending either — the status field, not the directory, decides.
    const pending = await svc.list({ status: 'pending' });
    expect(pending.map((e) => e.id)).not.toContain('mid-move');
  });

  it('recovers a sending entry that carries no lastError', async () => {
    // The old stale-lock reset only fired when lastError was set, so a
    // 'sending' row without one was skipped on every pass, forever.
    const { smtp, svc } = mocks();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await queueDue(fsp, 'wedged', { status: 'sending', claimedAt: stale, attempts: 1 }, '.claim');

    await svc.checkAndSend();

    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('still lists an entry that is mid-send', async () => {
    const { svc } = mocks();
    await queueDue(
      fsp,
      'in-flight',
      { status: 'sending', claimedAt: new Date().toISOString() },
      '.claim',
    );

    const all = await svc.list({ status: 'all' });

    expect(all.map((e) => e.id)).toContain('in-flight');
  });

  it('reports a mid-send entry as uncancellable rather than missing', async () => {
    const { svc } = mocks();
    await queueDue(
      fsp,
      'cancel-race',
      { status: 'sending', claimedAt: new Date().toISOString() },
      '.claim',
    );

    await expect(svc.cancel('cancel-race')).rejects.toThrow(/already being sent/i);
  });
});
