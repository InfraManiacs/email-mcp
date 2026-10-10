import {
  buildAttachmentRecipient,
  buildAttachmentSender,
  createMcpHarness,
  createTestServices,
  type McpHarness,
  type TestServices,
  TmpFiles,
  waitForDelivery,
} from './helpers/index.js';

/**
 * End-to-end coverage of the outbound-attachment feature, driven through the
 * real MCP tool layer (send_email / reply_email / forward_email /
 * download_attachment) against a live GreenMail server.
 *
 * The point of this tier is the size-awareness contract — behaviour that lives
 * in the tool handlers and is invisible to service-level tests:
 *   • every send reports each attachment's size and the raw≈base64 total;
 *   • the cap is enforced on the BASE64-ENCODED total (what the wire carries),
 *     not the raw bytes, so a file that fits raw but not encoded is refused;
 *   • a refused send FAILS CLOSED — nothing reaches the recipient;
 *   • forwards carry the original attachments unless explicitly told not to.
 *
 * Sender is the primary test account (test@localhost); recipient is bob.
 */
describe('Attachment features (MCP tool layer, size-aware)', () => {
  const sender = buildAttachmentSender();
  const recipient = buildAttachmentRecipient();
  const tmp = new TmpFiles();

  // Deterministic sizes. 10 KB and ~293 KB stay under a 1 MB raw budget, but a
  // single 900 KB file's base64 encoding (×4/3 ≈ 1.1 MB) busts a 1 MB cap.
  const noteBytes = 10 * 1024;
  const photoBytes = 300_000;
  const bigRawFitsEncodedBusts = 900_000;

  let notePath: string;
  let photoPath: string;
  let bigPath: string;

  let genServices: TestServices;
  let recvServices: TestServices;
  let generous: McpHarness; // sends as sender, 25 MB cap
  let strict: McpHarness; // sends as sender, 1 MB cap
  let reader: McpHarness; // acts as recipient (read / reply / forward)

  beforeAll(async () => {
    notePath = tmp.file('note.txt', noteBytes);
    photoPath = tmp.file('photo.bin', photoBytes);
    bigPath = tmp.file('big.bin', bigRawFitsEncodedBusts);

    genServices = createTestServices(sender);
    recvServices = createTestServices(recipient);
    generous = await createMcpHarness(genServices.imapService, genServices.smtpService, 25);
    strict = await createMcpHarness(genServices.imapService, genServices.smtpService, 1);
    reader = await createMcpHarness(recvServices.imapService, recvServices.smtpService, 25);
  });

  afterAll(async () => {
    await generous.close();
    await strict.close();
    await reader.close();
    await genServices.connections.closeAll();
    await recvServices.connections.closeAll();
    tmp.cleanup();
  });

  /** Resolve a received email id on an account by subject keyword. */
  async function findId(h: McpHarness, account: string, subject: string): Promise<string> {
    await waitForDelivery();
    const res = await h.call('list_emails', { account, mailbox: 'INBOX', subject, pageSize: 25 });
    const id = res.text.match(/^\[(\d+)\]/m)?.[1];
    if (!id) throw new Error(`No mail matching "${subject}" for ${account}:\n${res.text}`);
    return id;
  }

  function inboxCount(text: string): number {
    return (text.match(/^\[\d+\]/gm) ?? []).length;
  }

  describe('send_email with attachments', () => {
    it('reports every attachment with its size and the raw≈encoded total', async () => {
      const res = await generous.call('send_email', {
        account: sender.name,
        to: ['attrecipient@example.test'],
        subject: 'ATT size report',
        body: 'two files',
        attachments: [notePath, photoPath],
      });

      expect(res.isError).toBe(false);
      expect(res.text).toContain('note.txt (10 KB)');
      expect(res.text).toContain('photo.bin (293 KB)');
      expect(res.text).toMatch(/Attachments \(2,/);
      expect(res.text).toMatch(/raw ≈ .* encoded/);
    });

    it('delivers the attachments so the recipient sees them', async () => {
      const id = await findId(reader, recipient.name, 'ATT size report');
      const res = await reader.call('get_email', { account: recipient.name, emailId: id });
      expect(res.text).toContain('note.txt');
      expect(res.text).toContain('photo.bin');
    });

    it('preserves exact byte size on download', async () => {
      const id = await findId(reader, recipient.name, 'ATT size report');
      const res = await reader.call('download_attachment', {
        account: recipient.name,
        id,
        filename: 'photo.bin',
      });
      const meta = JSON.parse(res.text.split('\n--- Base64')[0]!);
      expect(meta.size).toBe(photoBytes);
    });
  });

  describe('size cap enforcement (on the base64-encoded total)', () => {
    it('refuses a file that fits raw but busts the cap once encoded, explaining why', async () => {
      const res = await strict.call('send_email', {
        account: sender.name,
        to: ['attrecipient@example.test'],
        subject: 'ATT encoded-bust',
        body: 'x',
        attachments: [bigPath],
      });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/exceed/i);
      expect(res.text).toContain('1 MB'); // the configured cap
      expect(res.text).toContain('big.bin'); // per-file listing
      expect(res.text).toMatch(/base64-encoded/i); // names the real measure
    });

    it('fails closed — a refused oversized send delivers nothing', async () => {
      const before = await reader.call('list_emails', {
        account: recipient.name,
        mailbox: 'INBOX',
        pageSize: 100,
      });
      const countBefore = inboxCount(before.text);

      const res = await strict.call('send_email', {
        account: sender.name,
        to: ['attrecipient@example.test'],
        subject: 'ATT fail-closed',
        body: 'x',
        attachments: [bigPath],
      });
      expect(res.isError).toBe(true);
      await waitForDelivery();

      const after = await reader.call('list_emails', {
        account: recipient.name,
        mailbox: 'INBOX',
        pageSize: 100,
      });
      expect(inboxCount(after.text)).toBe(countBefore);
      expect(after.text).not.toContain('ATT fail-closed');
    });

    it('sums multiple files against the cap', async () => {
      const a = tmp.file('a.bin', 400_000);
      const b = tmp.file('b.bin', 400_000); // 800 KB raw ≈ 1.07 MB encoded > 1 MB
      const res = await strict.call('send_email', {
        account: sender.name,
        to: ['attrecipient@example.test'],
        subject: 'ATT sum',
        body: 'x',
        attachments: [a, b],
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('a.bin');
      expect(res.text).toContain('b.bin');
    });
  });

  describe('invalid attachment paths', () => {
    it('rejects a missing file, naming the path', async () => {
      const ghost = tmp.missing('ghost.pdf');
      const res = await generous.call('send_email', {
        account: sender.name,
        to: ['attrecipient@example.test'],
        subject: 'ATT ghost',
        body: 'x',
        attachments: [ghost],
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain(ghost);
    });

    it('rejects a directory path', async () => {
      const res = await generous.call('send_email', {
        account: sender.name,
        to: ['attrecipient@example.test'],
        subject: 'ATT dir',
        body: 'x',
        attachments: [tmp.dir()],
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/not a file/i);
    });
  });

  describe('reply_email with attachments', () => {
    it('reports the attached file size on a reply', async () => {
      const id = await findId(reader, recipient.name, 'ATT size report');
      const res = await reader.call('reply_email', {
        account: recipient.name,
        emailId: id,
        body: 'one back',
        attachments: [notePath],
      });
      expect(res.isError).toBe(false);
      expect(res.text).toContain('note.txt (10 KB)');
    });
  });

  describe('forward_email attachment carry-over', () => {
    it('re-attaches the original attachments by default', async () => {
      const id = await findId(reader, recipient.name, 'ATT size report');
      const res = await reader.call('forward_email', {
        account: recipient.name,
        emailId: id,
        to: ['attsender@example.test'],
      });
      expect(res.isError).toBe(false);

      const fwdId = await findId(generous, sender.name, 'Fwd: ATT size report');
      const fwd = await generous.call('get_email', { account: sender.name, emailId: fwdId });
      expect(fwd.text).toContain('note.txt');
      expect(fwd.text).toContain('photo.bin');
    });

    it('strips attachments when includeAttachments is false and says so', async () => {
      const id = await findId(reader, recipient.name, 'ATT size report');
      const res = await reader.call('forward_email', {
        account: recipient.name,
        emailId: id,
        to: ['attsender@example.test'],
        includeAttachments: false,
      });
      expect(res.isError).toBe(false);
      expect(res.text).toMatch(/not included/i);
    });
  });
});
