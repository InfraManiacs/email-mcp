import type { Email, EmailMeta, Mailbox } from '../types/index.js';
import { formatEmailFull, formatEmailList, formatMailboxes } from './presenters.js';

const meta = (over: Partial<EmailMeta> = {}): EmailMeta => ({
  id: '42',
  subject: 'Quarterly report',
  from: { name: 'Alice Smith', address: 'alice@example.com' },
  to: [{ address: 'me@example.com' }],
  date: '2026-10-10T08:00:00.000Z',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
  labels: [],
  ...over,
});

describe('formatEmailList', () => {
  it('renders one row per email with id, sender, and subject (color off)', () => {
    const out = formatEmailList(
      {
        items: [meta(), meta({ id: '7', subject: 'Lunch?', from: { address: 'bob@x.io' } })],
        total: 2,
        page: 1,
        pageSize: 20,
        hasMore: false,
      },
      'INBOX',
      { color: false },
    );
    expect(out).toContain('42');
    expect(out).toContain('Quarterly report');
    expect(out).toContain('Alice Smith');
    expect(out).toContain('7');
    expect(out).toContain('Lunch?');
    expect(out).toContain('INBOX');
  });

  it('marks unread, flagged, and attachment state with stable glyphs', () => {
    const out = formatEmailList(
      {
        items: [meta({ seen: false, flagged: true, hasAttachments: true })],
        total: 1,
        page: 1,
        pageSize: 20,
        hasMore: false,
      },
      'INBOX',
      { color: false },
    );
    expect(out).toContain('●'); // unread dot
    expect(out).toContain('★'); // flagged
    expect(out).toContain('📎'); // attachment
  });

  it('shows an empty-state line when there are no emails', () => {
    const out = formatEmailList(
      { items: [], total: 0, page: 1, pageSize: 20, hasMore: false },
      'INBOX',
      { color: false },
    );
    expect(out).toMatch(/no (e-?)?mails?/i);
  });

  it('notes more results when the page is not the last', () => {
    const out = formatEmailList(
      { items: [meta()], total: 50, page: 1, pageSize: 1, hasMore: true },
      'INBOX',
      { color: false },
    );
    expect(out).toMatch(/more/i);
  });
});

describe('formatEmailFull', () => {
  const email: Email = {
    ...meta(),
    cc: [{ address: 'cc@example.com' }],
    bodyText: 'Hello,\nThe report is attached.\n',
    bodyHtml: '<p>ignored when text present</p>',
    messageId: '<m1@example.com>',
    attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 }],
    headers: {},
  };

  it('shows headers, body text, and attachment names with sizes', () => {
    const out = formatEmailFull(email, { color: false });
    expect(out).toContain('alice@example.com');
    expect(out).toContain('Quarterly report');
    expect(out).toContain('cc@example.com');
    expect(out).toContain('The report is attached.');
    expect(out).toContain('report.pdf');
    expect(out).toContain('2 KB');
  });

  it('falls back to stripped HTML when there is no text body', () => {
    const out = formatEmailFull(
      { ...email, bodyText: undefined, bodyHtml: '<p>Hi <b>there</b></p>' },
      { color: false },
    );
    expect(out).toContain('Hi there');
    expect(out).not.toContain('<b>');
  });

  it('converts HTML via the shared converter: <br> breaks lines, entities decode', () => {
    // The old CLI-private stripHtml matched closing tags only, so <br>-separated
    // mail collapsed onto one line and most entities leaked through verbatim.
    const out = formatEmailFull(
      {
        ...email,
        bodyText: undefined,
        bodyHtml: 'line one<br>line two &rsquo; <a href="https://x.com/a">link</a>',
      },
      { color: false },
    );
    expect(out).toContain('line one\nline two');
    expect(out).toContain('’');
    expect(out).toContain('[link](https://x.com/a)');
  });
});

describe('formatMailboxes', () => {
  it('lists mailbox paths with unread/total when known', () => {
    const boxes: Mailbox[] = [
      { name: 'INBOX', path: 'INBOX', totalMessages: 10, unseenMessages: 3 } as Mailbox,
      { name: 'Archive', path: 'Archive' } as Mailbox,
    ];
    const out = formatMailboxes(boxes, { color: false });
    expect(out).toContain('INBOX');
    expect(out).toContain('Archive');
    expect(out).toContain('3');
  });
});
