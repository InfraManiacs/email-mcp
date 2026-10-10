/**
 * Keeps the local mirror inside its byte budget, and keeps the blob store and
 * its index from drifting apart.
 *
 * Eviction order is cheapest-to-rebuild-last. Envelopes are small and are what
 * every listing needs, so they go last; attachment bytes are the heaviest and
 * the easiest to re-download, so they go first:
 *
 *   1. attachment blobs, least-recently-read first
 *   2. message bodies, least-recently-read first (envelopes stay)
 *   3. envelopes older than the configured window — last resort only
 *
 * Everything here is best-effort and safe to interrupt: the mirror is
 * regenerable, so a partial pass just means the next one finishes the job.
 */

import { mcpLog } from '../logging.js';
import type BlobStore from './blob-store.js';
import type CacheStore from './store.js';

export interface BudgetResult {
  /** Bytes held (SQLite + blobs) before the pass. */
  usedBytesBefore: number;
  /** Bytes held after it. */
  usedBytesAfter: number;
  budgetBytes: number;
  evictedBlobs: number;
  evictedBodies: number;
  evictedMessages: number;
}

interface BudgetOptions {
  /**
   * Fraction of the budget to evict down to, so a cache sitting exactly at
   * the limit does not evict on every single cycle.
   */
  lowWaterRatio?: number;
  /** Envelopes older than this are evictable in the last-resort step. */
  windowDays?: number;
}

const DEFAULT_LOW_WATER_RATIO = 0.8;
const BATCH = 200;

/**
 * Bytes currently held: the SQLite mirror plus the attachment blobs.
 *
 * Attachment bytes come from the index, not from a directory walk — this is
 * called on every reconcile and again after each eviction, and a synchronous
 * stat-per-blob sweep would block the event loop of a stdio MCP server for
 * seconds once a few thousand attachments are cached. The directory is
 * reconciled against the index separately, in `collectOrphans`.
 */
function usage(store: CacheStore): number {
  return store.attachmentUsageBytes() + store.sizeBytes();
}

/**
 * Evict until the mirror is back under the low-water mark.
 *
 * @param maxSizeMb the configured budget; 0 disables enforcement entirely.
 */
export async function enforceBudget(
  store: CacheStore,
  blobs: BlobStore,
  maxSizeMb: number,
  options: BudgetOptions = {},
): Promise<BudgetResult> {
  const budgetBytes = maxSizeMb * 1024 * 1024;
  const usedBytesBefore = usage(store);
  const result: BudgetResult = {
    usedBytesBefore,
    usedBytesAfter: usedBytesBefore,
    budgetBytes,
    evictedBlobs: 0,
    evictedBodies: 0,
    evictedMessages: 0,
  };

  if (maxSizeMb <= 0 || usedBytesBefore <= budgetBytes) return result;

  const lowWater = budgetBytes * (options.lowWaterRatio ?? DEFAULT_LOW_WATER_RATIO);

  // ---- 1. Attachment blobs, coldest first.
  while (usage(store) > lowWater) {
    const candidates = store.listEvictableAttachments(BATCH);
    if (candidates.length === 0) break;

    for (const row of candidates) {
      store.deleteAttachment(row.account, row.mailbox, row.uid, row.uidValidity, row.partId);
      // Content is deduplicated: only the last reference may remove the bytes.
      if (store.countBlobRefs(row.sha256) === 0) {
        await blobs.delete(row.sha256);
      }
      result.evictedBlobs += 1;
      if (usage(store) <= lowWater) break;
    }
  }

  // ---- 2. Bodies, coldest first. Envelopes (and so every listing) survive.
  //
  // Vacuuming after each eviction is what makes the stop condition honest:
  // clearing a body only moves its pages to the freelist, and page_count —
  // the thing `usage` measures — does not drop until those pages are handed
  // back. Without this the loop would read "still over budget" after every
  // eviction and drain the whole cache. Bodies are large, so the number of
  // iterations here is small.
  while (usage(store) > lowWater) {
    const candidates = store.listEvictableBodies(BATCH);
    if (candidates.length === 0) break;

    let progressed = false;
    for (const row of candidates) {
      store.clearBody(row.account, row.mailbox, row.uid, row.uidValidity);
      store.incrementalVacuum();
      result.evictedBodies += 1;
      progressed = true;
      if (usage(store) <= lowWater) break;
    }
    if (!progressed) break;
  }

  // ---- 3. Last resort: envelopes beyond the retention window.
  const windowDays = options.windowDays ?? 0;
  if (windowDays > 0) {
    let cutoff = Date.now() - windowDays * 86_400_000;
    while (usage(store) > lowWater) {
      const removed = store.deleteMessagesOlderThan(cutoff, BATCH);
      if (removed === 0) {
        // Nothing left that old; walk the cutoff forward a day at a time
        // rather than deleting the newest mail in the mirror.
        cutoff += 86_400_000;
        if (cutoff >= Date.now()) break;
        continue;
      }
      result.evictedMessages += removed;
      store.incrementalVacuum();
    }
  }

  store.incrementalVacuum();
  result.usedBytesAfter = usage(store);

  if (result.evictedBlobs + result.evictedBodies + result.evictedMessages > 0) {
    await mcpLog(
      'info',
      'cache',
      `Cache budget enforced: ${result.evictedBlobs} attachment(s), ` +
        `${result.evictedBodies} body/bodies, ${result.evictedMessages} envelope(s) evicted ` +
        `(${Math.round(usedBytesBefore / 1024 / 1024)}MB → ` +
        `${Math.round(result.usedBytesAfter / 1024 / 1024)}MB of ${maxSizeMb}MB)`,
    );
  }

  return result;
}

/**
 * Reconcile the blob store against its index in both directions: content no
 * row references is deleted, and rows whose content has vanished are dropped
 * so the next read re-downloads instead of failing.
 *
 * @returns how many orphaned blobs were removed.
 */
export async function collectOrphans(store: CacheStore, blobs: BlobStore): Promise<number> {
  const indexed = new Set(store.listIndexedDigests());
  const onDisk = new Set(blobs.list());

  let removed = 0;
  for (const digest of onDisk) {
    if (!indexed.has(digest)) {
      await blobs.delete(digest);
      removed += 1;
    }
  }

  for (const digest of indexed) {
    if (!onDisk.has(digest)) store.deleteAttachmentsByDigest(digest);
  }

  return removed;
}
