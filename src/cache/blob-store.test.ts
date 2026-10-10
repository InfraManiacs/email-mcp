import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BlobStore from './blob-store.js';

function createStore() {
  const root = mkdtempSync(join(tmpdir(), 'blob-store-'));
  return { root, store: new BlobStore(root) };
}

describe('BlobStore', () => {
  it('round-trips content and addresses it by sha256', async () => {
    const { store } = createStore();
    const payload = Buffer.from('invoice bytes');

    const { sha256, size } = await store.put(payload);

    expect(size).toBe(payload.length);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.get(sha256)).toEqual(payload);
  });

  it('deduplicates identical content', async () => {
    const { root, store } = createStore();

    const a = await store.put(Buffer.from('same'));
    const b = await store.put(Buffer.from('same'));

    expect(a.sha256).toBe(b.sha256);
    expect(store.list()).toEqual([a.sha256]);
    // Sharded by the first two hex characters, like git's object store.
    expect(readdirSync(root)).toEqual([a.sha256.slice(0, 2)]);
  });

  it('returns undefined for content it does not hold', async () => {
    const { store } = createStore();

    expect(await store.get('0'.repeat(64))).toBeUndefined();
  });

  it('rejects and removes content whose hash does not verify', async () => {
    const { root, store } = createStore();
    const { sha256 } = await store.put(Buffer.from('original'));

    // Simulate on-disk corruption; a verified read must not hand it back.
    writeFileSync(join(root, sha256.slice(0, 2), sha256), 'tampered');

    expect(await store.get(sha256)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('writes owner-only files into an owner-only root', async () => {
    const { root, store } = createStore();
    const { sha256 } = await store.put(Buffer.from('secret'));

    const { statSync } = await import('node:fs');
    expect(statSync(join(root, sha256.slice(0, 2), sha256)).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('leaves no temporary files behind', async () => {
    const { root, store } = createStore();
    await store.put(Buffer.from('x'));

    const stray = readdirSync(root, { recursive: true, encoding: 'utf-8' }).filter((f) =>
      f.includes('.tmp'),
    );
    expect(stray).toEqual([]);
  });

  it('deletes content on request and reports total bytes held', async () => {
    const { store } = createStore();
    const { sha256 } = await store.put(Buffer.from('four'));
    await store.put(Buffer.from('bytes!'));

    expect(store.sizeBytes()).toBe(10);

    await store.delete(sha256);

    expect(await store.get(sha256)).toBeUndefined();
    expect(store.sizeBytes()).toBe(6);
  });

  it('tolerates deleting content it does not hold', async () => {
    const { store } = createStore();

    await expect(store.delete('a'.repeat(64))).resolves.toBeUndefined();
  });

  it('survives a missing root directory on read', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'blob-store-')), 'never-created');
    const store = new BlobStore(root);

    expect(store.list()).toEqual([]);
    expect(store.sizeBytes()).toBe(0);
    // The XDG contract allows the cache dir to vanish at any moment; a put
    // afterwards must recreate it rather than fail.
    const { sha256 } = await store.put(Buffer.from('recreated'));
    expect(readFileSync(join(root, sha256.slice(0, 2), sha256)).toString()).toBe('recreated');
  });
});
