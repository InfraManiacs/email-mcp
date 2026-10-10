import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SCHEDULED_DIR resolves from XDG state at module load — point it at a
// throwaway directory before the service (and its xdg import) are loaded.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'sched-'));

const { default: SchedulerService } = await import('./scheduler.service.js');

import type ImapService from './imap.service.js';
import type SmtpService from './smtp.service.js';

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
