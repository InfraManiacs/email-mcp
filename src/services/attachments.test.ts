import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareAttachments } from './attachments.js';

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
