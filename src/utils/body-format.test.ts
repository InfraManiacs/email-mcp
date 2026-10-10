import { applyBodyFormat, DEFAULT_MULTI_BODY_MAX, DEFAULT_SINGLE_BODY_MAX } from './body-format.js';

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
