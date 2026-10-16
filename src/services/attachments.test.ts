import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeAttachments, prepareAttachments } from './attachments.js';

// download_attachment's own description tells the model to get partIds from
// get_email, and partId is the ONLY selector that works for inline cid images:
// those usually carry no name parameter, so extractAttachments falls back to
// 'unnamed' and several of them collide. Until this rendered partId, the
// documented workflow could not be followed at all.
describe('describeAttachments', () => {
  it('names the part id so download_attachment can address it', () => {
    expect(
      describeAttachments([
        { filename: 'report.pdf', mimeType: 'application/pdf', size: 2048, partId: '2' },
      ]),
    ).toBe('report.pdf (application/pdf, 2 KB, partId 2)');
  });

  it('distinguishes several unnamed inline images by part id and cid', () => {
    const line = describeAttachments([
      {
        filename: 'unnamed',
        mimeType: 'image/png',
        size: 900,
        partId: '2',
        contentId: 'logo@x',
        inline: true,
      },
      {
        filename: 'unnamed',
        mimeType: 'image/jpeg',
        size: 1024,
        partId: '3',
        contentId: 'hero@x',
        inline: true,
      },
    ]);
    expect(line).toContain('partId 2');
    expect(line).toContain('partId 3');
    expect(line).toContain('cid:logo@x');
    expect(line).toContain('cid:hero@x');
    expect(line).toContain('inline');
  });

  it('omits the part id when the server supplied none', () => {
    expect(describeAttachments([{ filename: 'a.txt', mimeType: 'text/plain', size: 10 }])).toBe(
      'a.txt (text/plain, 10 B)',
    );
  });

  it('joins several attachments with a comma', () => {
    expect(
      describeAttachments([
        { filename: 'a.pdf', mimeType: 'application/pdf', size: 10, partId: '2' },
        { filename: 'b.pdf', mimeType: 'application/pdf', size: 20, partId: '3' },
      ]),
    ).toBe('a.pdf (application/pdf, 10 B, partId 2), b.pdf (application/pdf, 20 B, partId 3)');
  });

  it('returns an empty string for no attachments', () => {
    expect(describeAttachments([])).toBe('');
  });
});

describe('prepareAttachments', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'att-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stats each file and reports filename and byte size', async () => {
    const p = join(dir, 'report.pdf');
    writeFileSync(p, Buffer.alloc(1234));

    const result = await prepareAttachments([p], 25);

    expect(result.attachments).toEqual([{ filename: 'report.pdf', path: p, size: 1234 }]);
    expect(result.totalBytes).toBe(1234);
  });

  it('accepts object entries with cid, contentType, and a filename override', async () => {
    const p = join(dir, 'logo.png');
    writeFileSync(p, Buffer.alloc(10));

    const result = await prepareAttachments(
      [{ path: p, cid: 'logo@x', contentType: 'image/png', filename: 'brand.png' }],
      25,
    );

    expect(result.attachments).toEqual([
      { filename: 'brand.png', path: p, size: 10, cid: 'logo@x', contentType: 'image/png' },
    ]);
  });

  it('rejects a missing file with a clear error naming the path', async () => {
    const missing = join(dir, 'nope.txt');
    await expect(prepareAttachments([missing], 25)).rejects.toThrow(missing);
  });

  it('rejects when the base64-encoded total exceeds the cap, listing each file with its size', async () => {
    // 900_000 raw bytes -> ~1_200_000 encoded > 1 MB cap, while raw alone would pass.
    const p = join(dir, 'big.bin');
    writeFileSync(p, Buffer.alloc(900_000));

    await expect(prepareAttachments([p], 1)).rejects.toThrow(/big\.bin.*879\.?\d*\s*KB/s);
    await expect(prepareAttachments([p], 1)).rejects.toThrow(/1\s*MB/);
  });

  it('sums sizes across multiple files against the cap', async () => {
    const a = join(dir, 'a.bin');
    const b = join(dir, 'b.bin');
    writeFileSync(a, Buffer.alloc(500_000));
    writeFileSync(b, Buffer.alloc(500_000));

    await expect(prepareAttachments([a, b], 1)).rejects.toThrow(/a\.bin[\s\S]*b\.bin/);
    const ok = await prepareAttachments([a, b], 25);
    expect(ok.totalBytes).toBe(1_000_000);
  });

  it('rejects a directory path', async () => {
    await expect(prepareAttachments([dir], 25)).rejects.toThrow(/not a file/i);
  });
});
