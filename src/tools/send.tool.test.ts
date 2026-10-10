import { attachmentInputSchema } from './send.tool.js';

describe('attachmentInputSchema', () => {
  it('accepts a bare path and an object with inline metadata', () => {
    expect(attachmentInputSchema.parse('/tmp/a.pdf')).toBe('/tmp/a.pdf');
    expect(
      attachmentInputSchema.parse({
        path: '/tmp/logo.png',
        cid: 'logo@x',
        contentType: 'image/png',
        filename: 'brand.png',
      }),
    ).toMatchObject({ cid: 'logo@x' });
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    // A caller writing contentId instead of cid would otherwise get a send
    // that "succeeds" with an image that never embeds.
    expect(() =>
      attachmentInputSchema.parse({ path: '/tmp/logo.png', contentId: 'logo@x' }),
    ).toThrow();
  });
});
