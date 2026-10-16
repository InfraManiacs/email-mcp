import {
  applyBodyFormat,
  DEFAULT_MULTI_BODY_MAX,
  DEFAULT_SINGLE_BODY_MAX,
  unflowFormatFlowed,
} from './body-format.js';

// RFC 3676: a line ending in a space continues on the next one, a line that
// does not is a real break, one leading space is stuffing added on send, and
// DelSp=yes means the trailing space existed only to mark the wrap.
describe('unflowFormatFlowed', () => {
  it('joins soft-wrapped lines into one paragraph, keeping the space', () => {
    const flowed = 'this is a paragraph the sender wrapped \nat seventy-two columns.';
    expect(unflowFormatFlowed(flowed)).toBe(
      'this is a paragraph the sender wrapped at seventy-two columns.',
    );
  });

  it('keeps a hard break between paragraphs', () => {
    expect(unflowFormatFlowed('first para\n\nsecond para')).toBe('first para\n\nsecond para');
  });

  it('deletes the trailing space when DelSp is yes', () => {
    expect(unflowFormatFlowed('unbrea \nkable', true)).toBe('unbreakable');
  });

  it('removes the one leading space that space-stuffing added', () => {
    expect(unflowFormatFlowed(' From the desk of\n >not a quote')).toBe(
      'From the desk of\n>not a quote',
    );
  });

  it('joins only within one quote depth', () => {
    const flowed = '> quoted and wrapped \n> onwards\n>> deeper\nunquoted';
    expect(unflowFormatFlowed(flowed)).toBe('> quoted and wrapped onwards\n>> deeper\nunquoted');
  });

  it('treats the signature separator as a hard break despite its trailing space', () => {
    expect(unflowFormatFlowed('Regards\n-- \nColin')).toBe('Regards\n-- \nColin');
  });

  it('leaves a body with no soft breaks untouched', () => {
    expect(unflowFormatFlowed('one\ntwo\nthree')).toBe('one\ntwo\nthree');
  });
});

describe('applyBodyFormat', () => {
  it('format=full prefers bodyText and falls back to raw HTML, then a placeholder', () => {
    expect(applyBodyFormat('plain', '<p>html</p>', 'full')).toBe('plain');
    expect(applyBodyFormat(undefined, '<p>html</p>', 'full')).toBe('<p>html</p>');
    expect(applyBodyFormat(undefined, undefined, 'full')).toBe('(no content)');
  });

  it('format=text converts HTML through the shared converter', () => {
    // Markdown links prove this is the structure-aware stripHtml, not a
    // local tag-remover.
    expect(applyBodyFormat(undefined, '<a href="https://x.com/a">link</a>', 'text')).toBe(
      '[link](https://x.com/a)',
    );
  });

  it('format=stripped removes quoted reply chains', () => {
    const text = 'Thanks!\n> original message\n> more quote';
    expect(applyBodyFormat(text, undefined, 'stripped')).toBe('Thanks!');
  });

  it('truncates at maxLength with a hint naming the remaining characters', () => {
    const out = applyBodyFormat('a'.repeat(150), undefined, 'text', 100);
    expect(out).toContain('a'.repeat(100));
    expect(out).toContain('50 more characters');
    expect(out).toContain('maxLength');
  });

  it('treats maxLength 0 as unlimited', () => {
    const long = 'a'.repeat(DEFAULT_SINGLE_BODY_MAX + 500);
    expect(applyBodyFormat(long, undefined, 'text', 0)).toBe(long);
  });

  it('exports the default caps the tool schemas advertise', () => {
    expect(DEFAULT_SINGLE_BODY_MAX).toBe(10_000);
    expect(DEFAULT_MULTI_BODY_MAX).toBe(5_000);
  });
});
