/**
 * HTML-to-text conversion for email bodies.
 *
 * Most mail arrives as HTML — 165 of 169 messages in one real mailbox were
 * single-part `text/html` — so this runs on nearly every body the server
 * returns, and undecoded entities show up directly in what the model reads.
 */

/**
 * Named entities worth carrying.
 *
 * The full HTML5 set runs to ~2,000 names, which is not worth embedding for
 * email. This covers the XML five, the Latin-1 letters that German and French
 * senders rely on, and the typographic punctuation that mail composers emit
 * constantly (curly quotes, dashes, ellipsis, zero-width and soft hyphens).
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '­',
  zwnj: '‌',
  zwj: '‍',
  // Typographic punctuation
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  // Arrows — common in newsletter call-to-action links ("Read more &rarr;")
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  // Symbols
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  deg: '°',
  times: '×',
  // Latin-1 letters
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  oslash: 'ø',
  ugrave: 'ù',
  uacute: 'ú',
};

/** Matches a named, decimal or hexadecimal character reference. */
const ENTITY_PATTERN = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/**
 * Decode HTML character references.
 *
 * Single pass by design: decoding repeatedly would turn the literal text
 * `&amp;lt;` into `<`, when it means the four characters `&lt;`.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (match, dec: string, hex: string, name: string) => {
    if (dec !== undefined || hex !== undefined) {
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      // Surrogate halves and anything past the Unicode range would make
      // String.fromCodePoint throw; leave those as written.
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[name] ?? match;
  });
}

/**
 * Invisible formatting characters with no semantic role in an email body.
 *
 * Bulk senders pad the inbox preview line with hundreds of these — zero-width
 * spaces, soft hyphens, combining grapheme joiners. They render as nothing but
 * a model still spends tokens reading them, and they keep otherwise-blank
 * lines from collapsing.
 *
 * Deliberately excludes ZWNJ (U+200C) and ZWJ (U+200D): both are meaningful,
 * ZWJ most visibly in emoji sequences, where dropping it splits a family
 * emoji into separate people.
 */
// Written as an alternation rather than a character class: U+034F is a
// combining mark, and inside a class it can bind to a neighbouring character.
// Escapes rather than literals so the set is visible when reading the source.
const INVISIBLE_PADDING = /\u200B|\u00AD|\u034F|\u2060|\uFEFF/g; // ZWSP, soft hyphen, CGJ, word joiner, BOM

/**
 * Zero-width joiners used as spacing rather than as text.
 *
 * ZWNJ and ZWJ are semantic between letters — ZWJ composes emoji sequences,
 * ZWNJ blocks ligatures in Persian and Indic scripts — so they cannot be
 * removed outright. Used as preview padding they appear next to whitespace or
 * in runs, never between two letters, which is what this matches.
 */
const JOINER_PADDING = /(?<![^\s])[\u200C\u200D]+(?=[\s\u200C\u200D]|$)|(?<=\s)[\u200C\u200D]+/g;

// Blockquote boundaries survive the tag strip as private-use markers; a line
// walk afterwards turns nesting depth into "> " prefixes. Markers instead of
// in-place prefixing because at tag-removal time the content has no line
// breaks yet to prefix.
const QUOTE_OPEN = '\uE000';
const QUOTE_CLOSE = '\uE001';

const ANCHOR_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
const IMG_RE = /<img\b[^>]*>/gi;
const ALT_ATTR = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Scheme, www. and a trailing slash are display noise, not a different link. */
function normalizeUrlForCompare(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

function imgAlt(tag: string): string {
  const m = ALT_ATTR.exec(tag);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

function imgSrc(tag: string): string {
  const m = SRC_ATTR.exec(tag);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

/**
 * Replace anchors with markdown links before any tag is stripped — once tags
 * are gone the href is unrecoverable (the same reason extractMagicLink parses
 * anchors first). Entities stay encoded here; the pipeline's single
 * decodeEntities pass at the end decodes link text and href together.
 */
function convertAnchors(html: string): string {
  return html.replace(ANCHOR_RE, (_m, dq: string, sq: string, bare: string, inner: string) => {
    const href = (dq ?? sq ?? bare ?? '').trim();
    // Inside an anchor an image is standing in for the link text.
    const text = inner
      .replace(IMG_RE, (img) => imgAlt(img))
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return text;
    if (/^mailto:/i.test(href)) {
      const address = href.slice('mailto:'.length).trim();
      if (!text || text.toLowerCase() === address.toLowerCase()) return address;
      return `[${text}](${href})`;
    }
    if (!text || normalizeUrlForCompare(text) === normalizeUrlForCompare(href)) return href;
    return `[${text}](${href})`;
  });
}

/**
 * Replace images with placeholders. A cid: image is real content shipped with
 * the message, so its existence is worth a token even without alt text; a
 * remote image without alt text is overwhelmingly a tracking pixel or spacer.
 */
function convertImages(html: string): string {
  return html.replace(IMG_RE, (img) => {
    const alt = imgAlt(img);
    if (alt) return `[image: ${alt}]`;
    if (imgSrc(img).toLowerCase().startsWith('cid:')) return '[image]';
    return '';
  });
}

/**
 * Number ordered-list items and bullet unordered ones, innermost list first so
 * a nested <ul> inside an <ol> keeps its bullets. Bounded: real mail does not
 * nest lists 20 deep, and pathological input must not loop forever.
 */
function convertLists(html: string): string {
  let out = html;
  for (let pass = 0; pass < 20; pass += 1) {
    const next = out.replace(
      /<(ol|ul)\b[^>]*>((?:(?!<[ou]l\b)[\s\S])*?)<\/\1\s*>/gi,
      (_m, tag: string, inner: string) => {
        let n = 0;
        const items = inner.replace(/<li\b[^>]*>/gi, () => {
          if (tag.toLowerCase() === 'ol') {
            n += 1;
            return `\n${n}. `;
          }
          return '\n• ';
        });
        return `\n${items}\n`;
      },
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Turn quote markers into "> " line prefixes, nesting into "> > ". */
function applyQuoteMarkers(text: string): string {
  if (!text.includes(QUOTE_OPEN) && !text.includes(QUOTE_CLOSE)) return text;
  let depth = 0;
  const out: string[] = [];
  text.split('\n').forEach((line) => {
    if (line.includes(QUOTE_OPEN) || line.includes(QUOTE_CLOSE)) {
      let residual = '';
      [...line].forEach((ch) => {
        if (ch === QUOTE_OPEN) depth += 1;
        else if (ch === QUOTE_CLOSE) depth = Math.max(0, depth - 1);
        else residual += ch;
      });
      if (residual.trim()) out.push('> '.repeat(depth) + residual.trim());
      return;
    }
    if (depth > 0 && line.trim()) {
      out.push('> '.repeat(depth) + line);
      return;
    }
    out.push(line);
  });
  return out.join('\n');
}

/**
 * Convert an HTML body to readable plain text.
 *
 * Structure survives as text conventions — markdown links, "> " quote
 * prefixes, numbered lists, pipe-separated table cells — and everything else
 * is dropped. Entities are decoded before padding is removed, since the
 * padding usually arrives entity-encoded — and after tags are gone, so an
 * entity-encoded angle bracket can never be mistaken for markup.
 */
export function stripHtml(html: string): string {
  const withoutMarkup = convertLists(
    convertImages(
      convertAnchors(
        html
          // The quote markers are ours alone; drop impostors from the input.
          .replace(/[\uE000\uE001]/g, '')
          // Elements whose text is machinery, not content. Dropping the tags
          // alone would leave their values inline — Outlook-authored mail
          // otherwise opens with "96" from <o:PixelsPerInch>.
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<xml[^>]*>[\s\S]*?<\/xml>/gi, '')
          .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '')
          // Conditional comments carry a whole alternate layout for Outlook.
          .replace(/<!--[\s\S]*?-->/g, ''),
      ),
    ),
  )
    .replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_OPEN}\n`)
    .replace(/<\/blockquote>/gi, `\n${QUOTE_CLOSE}\n`)
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/?h[1-6]\b[^>]*>/gi, '\n\n')
    .replace(/<hr\b[^>]*>/gi, '\n---\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/table>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '');

  return (
    applyQuoteMarkers(
      decodeEntities(withoutMarkup)
        .replace(INVISIBLE_PADDING, '')
        .replace(JOINER_PADDING, '')
        // U+00A0 is the correct decoding of &nbsp;, but layout tables emit rows
        // of them. Treat it as ordinary whitespace here so those lines collapse;
        // one sitting inside a sentence ("10 CHF") is left as a single space.
        .replace(/ /g, ' ')
        // Cell separators against a line boundary are table framing, not
        // content — a one-column layout table reads as plain lines without them.
        .replace(/[ \t]*(?:\|[ \t]*)+$/gm, '')
        .replace(/^[ \t]*(?:\|[ \t]*)+/gm, ''),
    )
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      // A list reads as one block; padding newlines between items are framing.
      .replace(/\n{2,}(?=(?:\d+\. |• ))/g, '\n')
      .trim()
  );
}
