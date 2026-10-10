/**
 * Content-addressed store for attachment bytes.
 *
 * Attachment content is immutable for a given (UIDVALIDITY, UID, part) — IMAP
 * guarantees it — so it is addressed by the SHA-256 of its bytes rather than
 * by message coordinates. Three properties fall out of that:
 *
 * - **Dedup is free.** The same PDF forwarded across threads and accounts is
 *   stored once.
 * - **Reads are verified.** Every read re-hashes; corrupted or tampered
 *   content is removed and reported as a miss rather than handed to a caller.
 *   This is why writes need no fsync discipline — a torn file cannot match
 *   its own name, so it is unreachable garbage the next read cleans up.
 * - **Writes are atomic.** Content lands in a temp file in its final
 *   directory, created 0600, then renamed into place.
 *
 * Paths shard on the first two hex characters of the digest, the layout git
 * and npm's cacache both use, to keep directory entry counts bounded.
 *
 * The index that maps messages to digests lives in SQLite (`attachment`
 * table); this class knows nothing about mail. Everything here is safe to
 * delete at any time, per the XDG cache contract.
 */

import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface StoredBlob {
  sha256: string;
  size: number;
}

export default class BlobStore {
  constructor(private readonly root: string) {}

  private static digest(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /** `<root>/ab/abcdef…` — sharded to bound directory size. */
  private pathFor(sha256: string): string {
    return path.join(this.root, sha256.slice(0, 2), sha256);
  }

  /**
   * Store content, returning its address. Writing content that is already
   * held is a no-op beyond the hash.
   */
  async put(content: Buffer): Promise<StoredBlob> {
    const sha256 = BlobStore.digest(content);
    const target = this.pathFor(sha256);
    const dir = path.dirname(target);

    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    try {
      await fs.access(target);
      return { sha256, size: content.length };
    } catch {
      // Not held yet — write it.
    }

    // Temp file in the *same* directory, so the rename never crosses a
    // filesystem boundary, and 0600 from creation so the rename can never
    // widen permissions.
    const temp = path.join(dir, `.tmp-${randomUUID()}`);
    try {
      await fs.writeFile(temp, content, { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }

    return { sha256, size: content.length };
  }

  /**
   * Read content back, verifying it against its address.
   *
   * @returns the bytes, or undefined when absent or corrupt.
   */
  async get(sha256: string): Promise<Buffer | undefined> {
    let content: Buffer;
    try {
      content = await fs.readFile(this.pathFor(sha256));
    } catch {
      return undefined;
    }

    if (BlobStore.digest(content) !== sha256) {
      // Self-healing: content that does not match its name is garbage, and
      // keeping it would both lie to callers and waste the byte budget.
      await this.delete(sha256);
      return undefined;
    }

    return content;
  }

  /** Remove content. Absent content is not an error. */
  async delete(sha256: string): Promise<void> {
    await fs.rm(this.pathFor(sha256), { force: true });
  }

  /** Every digest currently held, for orphan reconciliation against the index. */
  list(): string[] {
    const digests: string[] = [];
    let shards: string[];
    try {
      shards = fsSync.readdirSync(this.root);
    } catch {
      return digests;
    }

    for (const shard of shards) {
      let entries: string[];
      try {
        entries = fsSync.readdirSync(path.join(this.root, shard));
      } catch {
        continue;
      }
      for (const entry of entries) {
        // Skip in-flight temp files from a concurrent put.
        if (!entry.startsWith('.tmp-')) digests.push(entry);
      }
    }

    return digests;
  }

  /** Total bytes held, counted toward the shared cache budget. */
  sizeBytes(): number {
    let total = 0;
    for (const sha256 of this.list()) {
      try {
        total += fsSync.statSync(this.pathFor(sha256)).size;
      } catch {
        // Raced with a delete; it contributes nothing.
      }
    }
    return total;
  }
}
