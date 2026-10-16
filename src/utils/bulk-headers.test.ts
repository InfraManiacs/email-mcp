import { classifyBulk, formatBulk } from './bulk-headers.js';

describe('classifyBulk', () => {
  it('returns undefined for ordinary personal mail', () => {
    expect(classifyBulk({ subject: 'Lunch?', from: 'friend@example.com' })).toBeUndefined();
  });

  it('classifies List-Unsubscribe as a newsletter', () => {
    const signal = classifyBulk({ 'list-unsubscribe': '<https://example.com/u/abc>' });

    expect(signal?.kind).toBe('newsletter');
    expect(signal?.unsubscribe).toBe('https://example.com/u/abc');
    expect(signal?.oneClick).toBe(false);
  });

  it('prefers an https unsubscribe URI over mailto', () => {
    const signal = classifyBulk({
      'list-unsubscribe': '<mailto:unsub@example.com>, <https://example.com/u/abc>',
    });

    expect(signal?.unsubscribe).toBe('https://example.com/u/abc');
  });

  it('falls back to mailto when no http URI is offered', () => {
    const signal = classifyBulk({ 'list-unsubscribe': '<mailto:unsub@example.com>' });

    expect(signal?.unsubscribe).toBe('mailto:unsub@example.com');
  });

  it('flags one-click unsubscribe from List-Unsubscribe-Post', () => {
    const signal = classifyBulk({
      'list-unsubscribe': '<https://example.com/u/abc>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    });

    expect(signal?.oneClick).toBe(true);
  });

  it('strips angle brackets from List-Id', () => {
    expect(classifyBulk({ 'list-id': 'News <news.example.com>' })?.listId).toBe('news.example.com');
  });

  it('classifies Auto-Submitted as automated', () => {
    const signal = classifyBulk({ 'auto-submitted': 'auto-generated' });

    expect(signal?.kind).toBe('automated');
    expect(signal?.unsubscribe).toBeUndefined();
  });

  it('treats Auto-Submitted: no as personal mail', () => {
    expect(classifyBulk({ 'auto-submitted': 'no' })).toBeUndefined();
  });

  it('classifies Precedence: bulk as automated', () => {
    expect(classifyBulk({ precedence: 'bulk' })?.kind).toBe('automated');
  });

  it('classifies Precedence: list as a newsletter', () => {
    expect(classifyBulk({ precedence: 'list' })?.kind).toBe('newsletter');
  });

  it('prefers newsletter when a sender sets both list and automated markers', () => {
    const signal = classifyBulk({
      'list-unsubscribe': '<https://example.com/u/abc>',
      'auto-submitted': 'auto-generated',
      precedence: 'bulk',
    });

    expect(signal?.kind).toBe('newsletter');
  });
});

describe('formatBulk', () => {
  it('renders nothing for personal mail', () => {
    expect(formatBulk(undefined)).toBe('');
  });

  it('renders a bare newsletter marker', () => {
    expect(formatBulk({ kind: 'newsletter', oneClick: false })).toBe('📰 newsletter');
  });

  it('includes the list id and unsubscribe availability', () => {
    expect(
      formatBulk({
        kind: 'newsletter',
        listId: 'news.example.com',
        unsubscribe: 'https://example.com/u/abc',
        oneClick: true,
      }),
    ).toBe('📰 newsletter (news.example.com) · unsub 1-click');
  });

  it('omits the 1-click hint when RFC 8058 is not supported', () => {
    expect(
      formatBulk({ kind: 'newsletter', unsubscribe: 'mailto:u@example.com', oneClick: false }),
    ).toBe('📰 newsletter · unsub');
  });

  it('renders the automated marker', () => {
    expect(formatBulk({ kind: 'automated', oneClick: false })).toBe('🤖 automated');
  });
});
