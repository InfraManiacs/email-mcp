import { decodeEntities, stripHtml } from './html.js';
import { stripReplyChain } from './reply-chain.js';

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot;')).toBe('a & b <c> "d"');
  });

  it('decodes Latin-1 letters used by German senders', () => {
    // Seen verbatim in real mail: "am n&auml;chsten Werktag".
    expect(decodeEntities('n&auml;chsten Gr&uuml;&szlig;e')).toBe('nächsten Grüße');
  });

  it('decodes decimal numeric entities', () => {
    // Zero-width spaces and soft hyphens are sprinkled through marketing mail.
    expect(decodeEntities('a&#8203;b&#847;c')).toBe('a​b͏c');
  });

  it('decodes hexadecimal numeric entities', () => {
    expect(decodeEntities('&#x2019;')).toBe('’');
  });

  it('decodes typographic punctuation', () => {
    expect(decodeEntities('We&rsquo;re &mdash; here&hellip;')).toBe('We’re — here…');
  });

  it('does not re-decode the output of a previous decode', () => {
    // "&amp;lt;" means the literal text "&lt;", not "<". Decoding in
    // sequential passes would wrongly produce "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('&notarealentity; &#;')).toBe('&notarealentity; &#;');
  });

  it('rejects out-of-range code points rather than throwing', () => {
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');
  });
});

describe('stripHtml — non-content markup', () => {
  it('drops Office document settings', () => {
    // Outlook-authored mail opens with an XML island; stripping only the tags
    // leaves its values ("96") as the first thing the model reads.
    const html =
      '<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch>' +
      '</o:OfficeDocumentSettings></xml><p>Real content</p>';
    expect(stripHtml(html)).toBe('Real content');
  });

  it('drops conditional comments', () => {
    expect(stripHtml('<!--[if mso]><table><tr><td>hidden<![endif]--><p>shown</p>')).toBe('shown');
  });

  it('drops the document title', () => {
    expect(stripHtml('<head><title>Newsletter #42</title></head><p>body</p>')).toBe('body');
  });

  it('decodes arrow entities', () => {
    expect(decodeEntities('Read more &rarr;')).toBe('Read more →');
  });
});

describe('stripHtml — invisible characters', () => {
  it('removes zero-width and soft-hyphen padding', () => {
    // Marketing mail pads the inbox preview line with hundreds of these.
    // Decoded they are invisible, but a model still pays tokens to read them.
    const padded = `Real text${'͏​­'.repeat(30)}`;
    expect(stripHtml(padded)).toBe('Real text');
  });

  it('keeps zero-width joiners, which carry meaning', () => {
    // ZWJ composes emoji sequences; dropping it splits 👨‍👩‍👧 into three people.
    expect(stripHtml('<p>👨‍👩‍👧</p>')).toBe('👨‍👩‍👧');
  });

  it('keeps a zero-width non-joiner sitting between letters', () => {
    // Semantic in Persian and Indic scripts: it prevents ligature forming.
    expect(stripHtml('<p>می‌رود</p>')).toBe('می‌رود');
  });

  it('removes zero-width joiners used as preview padding', () => {
    // Padding puts them between spaces; real usage puts them between letters.
    expect(stripHtml('<p>‌ ‌ ‌ ‌ ‌ Werden diese E-Mail</p>')).toBe('Werden diese E-Mail');
  });

  it('collapses the blank lines that padding leaves behind', () => {
    expect(stripHtml('<p>a</p>​​\n​\n​\n<p>b</p>')).toBe('a\n\nb');
  });

  it('treats non-breaking spaces as whitespace when collapsing', () => {
    // decodeEntities correctly yields U+00A0 for &nbsp;, but layout tables
    // emit rows of them; without normalizing, those lines never collapse.
    expect(stripHtml('a<br>&nbsp;&nbsp;&nbsp;<br>&nbsp;<br>b')).toBe('a\n\nb');
  });

  it('keeps a non-breaking space inside a sentence, as an ordinary space', () => {
    // Asserted via escape on purpose: a literal U+00A0 here is invisible in
    // the diff and makes any failure unreadable.
    expect(stripHtml('<p>10&nbsp;CHF</p>')).toBe('10\u0020CHF');
  });
});

describe('stripHtml — links', () => {
  it('converts an anchor into a markdown link', () => {
    expect(
      stripHtml('<p>Confirm: <a href="https://example.com/verify?t=abc">Verify email</a></p>'),
    ).toBe('Confirm: [Verify email](https://example.com/verify?t=abc)');
  });

  it('collapses an anchor whose text is its own URL to the bare URL', () => {
    expect(stripHtml('<a href="https://example.com/help">https://example.com/help</a>')).toBe(
      'https://example.com/help',
    );
    // Scheme, www. and a trailing slash are display noise, not a different link.
    expect(stripHtml('<a href="https://www.example.com/">example.com</a>')).toBe(
      'https://www.example.com/',
    );
  });

  it('decodes &amp; inside a preserved href', () => {
    expect(stripHtml('<a href="https://x.com/?a=1&amp;b=2">link</a>')).toBe(
      '[link](https://x.com/?a=1&b=2)',
    );
  });

  it('drops javascript:, fragment, and empty hrefs but keeps the text', () => {
    expect(stripHtml('<a href="javascript:void(0)">menu</a>')).toBe('menu');
    expect(stripHtml('<a href="#section">jump</a>')).toBe('jump');
    expect(stripHtml('<a href="">nothing</a>')).toBe('nothing');
  });

  it('collapses a mailto link with matching text to the bare address', () => {
    expect(stripHtml('<a href="mailto:ada@example.com">ada@example.com</a>')).toBe(
      'ada@example.com',
    );
    expect(stripHtml('<a href="mailto:ada@example.com">Contact us</a>')).toBe(
      '[Contact us](mailto:ada@example.com)',
    );
  });

  it('uses image alt text for an image-only anchor, or the bare URL without one', () => {
    expect(stripHtml('<a href="https://x.com"><img src="https://c.dn/l.png" alt="Logo"></a>')).toBe(
      '[Logo](https://x.com)',
    );
    expect(stripHtml('<a href="https://x.com"><img src="cid:img1" alt=""></a>')).toBe(
      'https://x.com',
    );
  });
});

describe('stripHtml — images', () => {
  it('renders alt text as an image placeholder', () => {
    expect(stripHtml('<p>See <img src="https://c.dn/chart.png" alt="Q3 chart"> above</p>')).toBe(
      'See [image: Q3 chart] above',
    );
  });

  it('marks an inline cid image without alt text', () => {
    // cid: parts ship with the message — the model should know one exists.
    expect(stripHtml('<p>Logo: <img src="cid:logo@x"></p>')).toBe('Logo: [image]');
  });

  it('drops remote images without alt text (tracking pixels, spacers)', () => {
    expect(stripHtml('<p>Hi<img src="https://t.rack/px.gif" width="1"></p>')).toBe('Hi');
  });
});

describe('stripHtml — sender-controlled hostile input', () => {
  it('cannot be tricked into quoting content with entity-encoded quote markers', () => {
    // The blockquote markers are private-use characters stripped from the
    // input — but entity references decode AFTER that strip, so
    // "&#xE000;" would smuggle a live marker in and make everything after it
    // look quoted. stripReplyChain then deletes it entirely, letting a sender
    // choose what the model never sees.
    const html = '<p>Dear customer,</p><p>&#xE000;</p><p>Please wire CHF 50000.</p>';
    const out = stripHtml(html);

    expect(out).toContain('Please wire CHF 50000.');
    expect(out).not.toMatch(/^>/m);
    expect(stripReplyChain(out)).toContain('Please wire CHF 50000.');
  });

  it('keeps a decimal-encoded marker inert too', () => {
    expect(stripHtml('<p>a</p><p>&#57345;</p><p>b</p>')).not.toMatch(/^>/m);
  });

  it('converts a document full of unclosed anchors promptly', () => {
    // ANCHOR_RE's trailing lazy scan is quadratic against unclosed tags: 50k
    // of them took >4s, blocking the loop that also serves IMAP IDLE, the
    // watcher, and the scheduler.
    const html = '<a href=x>'.repeat(50_000);
    const started = process.hrtime.bigint();

    stripHtml(html);

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('does not leak attribute text when a quoted value contains ">"', () => {
    // "a > b" needs no escaping inside an attribute value, so this is valid
    // mail — but a tag matcher that stops at the first ">" cuts mid-attribute
    // and spills the rest, URL and quote characters included, into the body.
    const out = stripHtml('<a title="a > b" href="https://e.test/x">click</a>');

    expect(out).toBe('[click](https://e.test/x)');
    expect(stripHtml('<img alt="Price > 100" src="cid:p">')).toBe('[image: Price > 100]');
    expect(stripHtml('<td style="a>b">cell</td>')).toBe('cell');
  });

  it('drops an unclosed style or script block instead of printing its source', () => {
    // A >512KB newsletter is truncated mid-markup by the body cap, which
    // routinely produces exactly this shape.
    expect(stripHtml('<p>hi</p><style>.a{color:red} /*')).toBe('hi');
    expect(stripHtml('<p>hi</p><script>var a = 1;')).toBe('hi');
    expect(stripHtml('<p>hi</p><!-- unterminated comment')).toBe('hi');
  });
});

describe('stripHtml — structure', () => {
  it('separates table cells with pipes and rows with newlines', () => {
    const html = '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>7</td></tr></table>';
    expect(stripHtml(html)).toBe('Name | Age\nAnn | 7');
  });

  it('degrades single-cell layout tables to plain lines without pipe noise', () => {
    const html = '<table><tr><td>Hello</td></tr><tr><td>World</td></tr></table>';
    expect(stripHtml(html)).toBe('Hello\nWorld');
  });

  it('separates headings from surrounding text', () => {
    expect(stripHtml('intro<h1>Title</h1>para')).toBe('intro\n\nTitle\n\npara');
  });

  it('treats <br> with attributes as a line break', () => {
    expect(stripHtml('a<br class="x">b')).toBe('a\nb');
  });

  it('renders a horizontal rule as a divider line', () => {
    expect(stripHtml('a<hr>b')).toBe('a\n---\nb');
  });

  it('prefixes blockquote content with "> "', () => {
    expect(stripHtml('<p>reply</p><blockquote><p>original</p></blockquote>')).toBe(
      'reply\n\n> original',
    );
  });

  it('nests blockquote prefixes', () => {
    const html = '<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>';
    expect(stripHtml(html)).toBe('> outer\n\n> > inner');
  });

  it('numbers ordered list items', () => {
    expect(stripHtml('<ol><li>first</li><li>second</li></ol>')).toBe('1. first\n2. second');
  });

  it('keeps bullets for an unordered list nested inside an ordered one', () => {
    expect(stripHtml('<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>')).toBe(
      '1. one\n• sub\n2. two',
    );
  });
});

describe('stripHtml', () => {
  it('removes tags and collapses block elements into newlines', () => {
    expect(stripHtml('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
  });

  it('drops style and script content', () => {
    expect(stripHtml('<style>p{color:red}</style><p>visible</p>')).toBe('visible');
  });

  it('decodes entities in the stripped output', () => {
    expect(stripHtml('<p>We&rsquo;re at n&auml;chsten</p>')).toBe('We’re at nächsten');
  });

  it('renders list items as bullets', () => {
    expect(stripHtml('<ul><li>a</li><li>b</li></ul>')).toBe('• a\n• b');
  });
});
