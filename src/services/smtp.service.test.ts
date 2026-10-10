import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(mockTransport: ReturnType<typeof createMockTransport>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockImapService() {
  return {} as unknown as ImapService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    service = new SmtpService(connections, rateLimiter, createMockImapService());
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <test@example.com>',
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'World',
        }),
      );
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, createMockImapService());

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes CC and BCC when provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc1@example.com, cc2@example.com',
          bcc: 'bcc@example.com',
        }),
      );
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0]![0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBeUndefined();
    });
  });
});

describe('outbound attachments', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;

  function service(imap: ImapService = createMockImapService()) {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    return new SmtpService(connections, createMockRateLimiter(), imap);
  }

  it('sendEmail hands prepared attachments to the transport as file paths', async () => {
    const svc = service();
    await svc.sendEmail('test', {
      to: ['a@b.c'],
      subject: 's',
      body: 'b',
      attachments: [{ filename: 'report.pdf', path: '/tmp/report.pdf', size: 10 }],
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ filename: 'report.pdf', path: '/tmp/report.pdf' }],
      }),
    );
  });

  it('sendEmail omits the attachments key entirely when none are given', async () => {
    const svc = service();
    await svc.sendEmail('test', { to: ['a@b.c'], subject: 's', body: 'b' });

    const payload = transport.sendMail.mock.calls[0]![0];
    expect('attachments' in payload).toBe(false);
  });

  it('forwardEmail re-attaches the original attachments by default', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: 'hello',
        attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 3 }],
      }),
      downloadAttachment: vi.fn().mockResolvedValue({
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 3,
        contentBase64: Buffer.from('abc').toString('base64'),
      }),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'] });

    expect(imap.downloadAttachment).toHaveBeenCalledWith(
      'test',
      '1',
      'INBOX',
      'invoice.pdf',
      expect.any(Number),
    );
    const payload = transport.sendMail.mock.calls[0]![0];
    expect(payload.attachments).toEqual([
      {
        filename: 'invoice.pdf',
        content: Buffer.from('abc'),
        contentType: 'application/pdf',
      },
    ]);
  });

  it('forwardEmail skips attachments when includeAttachments is false', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: 'hello',
        attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 3 }],
      }),
      downloadAttachment: vi.fn(),
    } as unknown as ImapService;

    const svc = service(imap);
    await svc.forwardEmail('test', { emailId: '1', to: ['a@b.c'], includeAttachments: false });

    expect(imap.downloadAttachment).not.toHaveBeenCalled();
    const payload = transport.sendMail.mock.calls[0]![0];
    expect('attachments' in payload).toBe(false);
  });
});

describe('reply attachments', () => {
  it('replyToEmail hands prepared attachments to the transport', async () => {
    const imap = {
      getEmail: vi.fn().mockResolvedValue({
        subject: 'Orig',
        from: { address: 'x@y.z' },
        to: [{ address: 'me@y.z' }],
        date: '2026-01-01',
        bodyText: 'hello',
        messageId: '<m1@y.z>',
        references: [],
        attachments: [],
      }),
    } as unknown as ImapService;
    const transport = createMockTransport();
    const connections = createMockConnectionManager(transport);
    const svc = new SmtpService(connections, createMockRateLimiter(), imap);

    await svc.replyToEmail('test', {
      emailId: '1',
      body: 'r',
      attachments: [{ filename: 'a.txt', path: '/tmp/a.txt', size: 1 }],
    });

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ filename: 'a.txt', path: '/tmp/a.txt' }] }),
    );
  });
});
