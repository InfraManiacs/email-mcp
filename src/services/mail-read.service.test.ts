import { describe, expect, it, vi } from 'vitest';
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
