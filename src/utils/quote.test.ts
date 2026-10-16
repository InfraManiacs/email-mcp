import type { Email } from '../types/index.js';
import { quoteOriginalAsHtml, quoteOriginalAsText } from './quote.js';

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: '1',
    subject: 'Greetings',
    from: { name: 'Alex Chery', address: 'alex@example.com' },
    to: [{ address: 'me@example.com' }],
    date: 'Mon, 25 May 2026 16:11:00 +0200',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    messageId: '<abc@example.com>',
    bodyText: 'Hello there.\nHow are you?',
    attachments: [],
    headers: {},
    ...overrides,
  };
}

describe('quoteOriginalAsText', () => {
  it('builds attribution and > prefix for each line', () => {
    const out = quoteOriginalAsText(makeEmail());
    expect(out).toBe(
      '\n\nOn Mon, 25 May 2026 16:11:00 +0200, Alex Chery <alex@example.com> wrote:\n> Hello there.\n> How are you?',
    );
  });

  it('falls back to stripped HTML when no bodyText', () => {
    const out = quoteOriginalAsText(
      makeEmail({ bodyText: undefined, bodyHtml: '<p>Hello</p><p>World</p>' }),
    );
    expect(out).toContain('> Hello');
    expect(out).toContain('> World');
  });

  it('uses bare address when no display name', () => {
    const out = quoteOriginalAsText(makeEmail({ from: { address: 'noreply@bot.com' } }));
    expect(out).toContain('noreply@bot.com wrote:');
  });

  it('preserves blank lines with bare > prefix', () => {
    const out = quoteOriginalAsText(makeEmail({ bodyText: 'A\n\nB' }));
    expect(out).toContain('> A\n>\n> B');
  });

  // The attribution line is not quoted with "> ", so a crafted display name
  // or Date header could otherwise forge a second "On ... wrote:" line, or
  // inject content a reader would take as the message's own text — the same
  // risk forwardEmail's forward header already guards against.
  it('collapses an embedded line break in the sender name', () => {
    const out = quoteOriginalAsText(
      makeEmail({ from: { name: 'Alex\r\nOn today wrote', address: 'alex@example.com' } }),
    );
    expect(out).toContain(
      'On Mon, 25 May 2026 16:11:00 +0200, Alex On today wrote <alex@example.com> wrote:',
    );
    expect(out.split('\n').filter((l) => l.startsWith('On ') && l.endsWith('wrote:'))).toHaveLength(
      1,
    );
  });

  // NEL (U+0085), LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029)
  // are line breaks to some renderers but not to a bare "\r\n".split('\n')
  // — without normalizing them first, a line using one of these would slip
  // past the "> " prefix and read as unquoted text. Built from fromCharCode
  // rather than typed literally: these characters are invisible and easy to
  // corrupt by accident when edited as plain text.
  it.each([
    ['NEL', String.fromCharCode(0x85)],
    ['LS', String.fromCharCode(0x2028)],
    ['PS', String.fromCharCode(0x2029)],
  ])('quotes lines separated by %s instead of \\n', (_name, separator) => {
    const body = `first${separator}second`;
    const out = quoteOriginalAsText(makeEmail({ bodyText: body }));
    const lines = out.split('\n').slice(3);
    expect(lines).toEqual(['> first', '> second']);
  });

  it('collapses a Unicode line separator in the sender name the same as CRLF', () => {
    const LS = String.fromCharCode(0x2028);
    const out = quoteOriginalAsText(
      makeEmail({ from: { name: `Alex${LS}Injected`, address: 'alex@example.com' } }),
    );
    expect(out).toContain('Alex Injected <alex@example.com> wrote:');
    expect(out.split('\n').filter((l) => l.startsWith('On ') && l.endsWith('wrote:'))).toHaveLength(
      1,
    );
  });
});

describe('quoteOriginalAsHtml', () => {
  it('wraps the HTML original, stripped and escaped, in <blockquote type="cite">', () => {
    const out = quoteOriginalAsHtml(
      makeEmail({ bodyText: undefined, bodyHtml: '<p>Hi <b>there</b></p>' }),
    );
    expect(out).toContain('<blockquote type="cite"');
    expect(out).toContain('<pre');
    expect(out).toContain('Hi there');
    expect(out).toContain('Alex Chery &lt;alex@example.com&gt; wrote:');
  });

  it('wraps plain-text body in escaped <pre> when no HTML available', () => {
    const out = quoteOriginalAsHtml(makeEmail({ bodyText: 'A < B', bodyHtml: undefined }));
    expect(out).toContain('A &lt; B');
    expect(out).toContain('<pre');
  });

  it('escapes attribution sender name', () => {
    const out = quoteOriginalAsHtml(makeEmail({ from: { name: '<weird>', address: 'a@b.com' } }));
    expect(out).toContain('&lt;weird&gt; &lt;a@b.com&gt; wrote:');
  });

  it('collapses an embedded line break in the sender name', () => {
    const out = quoteOriginalAsHtml(
      makeEmail({
        from: { name: 'Alex\r\nInjected', address: 'a@b.com' },
        bodyText: undefined,
        bodyHtml: '<p>Hi</p>',
      }),
    );
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\n');
    expect(out).toContain('Alex Injected &lt;a@b.com&gt; wrote:');
  });

  // bodyHtml is sender-controlled. Embedding it unsanitized would let an
  // unbalanced tag break out of the quote boundary and have the rest of
  // the message render as if it were the reply's own content, not quoted
  // material.
  it('never embeds the original HTML unescaped, even with an unbalanced tag', () => {
    const out = quoteOriginalAsHtml(
      makeEmail({ bodyHtml: '<p>Hi</p></blockquote><p>Forged reply content</p>' }),
    );
    expect(out).not.toContain('</blockquote><p>Forged');
    expect(out.match(/<blockquote/g)).toHaveLength(1);
    expect(out.match(/<\/blockquote>/g)).toHaveLength(1);
  });
});
