/**
 * Persistent IDLE watermarks.
 *
 * The watcher reports a message once, by remembering the highest UID it has
 * seen per account and folder. Holding that only in memory meant every fresh
 * connection re-baselined to the server's current UIDNEXT, so anything that
 * arrived while the process was down — or during a reconnect — was skipped
 * silently: no notification, no hook, no event.
 *
 * Same read/write/lock shape as verification-state.ts, with one addition that
 * matters more here: a watermark is only meaningful against the UIDVALIDITY it
 * was recorded under. If the server renumbers a mailbox, the stored UID points
 * at an unrelated message, so the pair is stored and compared together.
 */

import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { WATCHER_STATE_FILE } from '../config/xdg.js';

const LOCK_FILE = `${WATCHER_STATE_FILE}.lock`;

export interface Watermark {
  /** UIDVALIDITY the UID below was observed under, as a decimal string. */
  uidValidity: string;
  lastSeenUid: number;
  updatedAt: string;
}

interface StateFile {
  watermarks: Record<string, Watermark>;
}

function stateKey(account: string, folder: string): string {
  return `${account.replace(/\s+/g, '_')}__${folder.replace(/\s+/g, '_')}`;
}

async function readState(): Promise<StateFile> {
  try {
    const raw = await readFile(WATCHER_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StateFile;
    return parsed.watermarks ? parsed : { watermarks: {} };
  } catch {
    return { watermarks: {} };
  }
}

/** Exclusive-create lock, matching the other state files in this directory. */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(LOCK_FILE), { recursive: true });

  const acquire = async (retries: number): Promise<Awaited<ReturnType<typeof open>>> => {
    try {
      return await open(LOCK_FILE, 'wx');
    } catch {
      if (retries <= 0) return open(LOCK_FILE, 'w');
      return new Promise<Awaited<ReturnType<typeof open>>>((resolve) => {
        setTimeout(() => {
          resolve(acquire(retries - 1));
        }, 50);
      });
    }
  };

  const lockHandle = await acquire(20);
  try {
    return await fn();
  } finally {
    await lockHandle.close();
    await unlink(LOCK_FILE).catch(() => {});
  }
}

/** The stored watermark for this account/folder, if any. */
export async function readWatermark(
  account: string,
  folder: string,
): Promise<Watermark | undefined> {
  const state = await readState();
  return state.watermarks[stateKey(account, folder)];
}

/** Record the highest UID reported for this account/folder. */
export async function writeWatermark(
  account: string,
  folder: string,
  uidValidity: string,
  lastSeenUid: number,
): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    state.watermarks[stateKey(account, folder)] = {
      uidValidity,
      lastSeenUid,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(WATCHER_STATE_FILE), { recursive: true });
    await writeFile(WATCHER_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  });
}

/**
 * Decide where a newly connected IDLE session should resume from.
 *
 * `uidNext - 1` is the "everything already here is old news" baseline, and it
 * is the right answer only when there is nothing better: the first time a
 * folder is watched, or when the mailbox has been renumbered. Otherwise resume
 * from the highest UID already reported, so the gap left by a restart or a
 * reconnect is reported rather than skipped.
 *
 * The in-memory value wins ties because it is never older than the file, and
 * one that has run ahead of UIDNEXT (a renumbered mailbox the UIDVALIDITY
 * check somehow missed) falls back to the baseline rather than going mute.
 */
export function resolveBaselineUid(opts: {
  inMemoryLastSeenUid: number;
  stored: Watermark | undefined;
  uidValidity: string;
  uidNext: number;
}): number {
  const { inMemoryLastSeenUid, stored, uidValidity, uidNext } = opts;
  const freshBaseline = Math.max(0, uidNext - 1);

  const candidates = [inMemoryLastSeenUid];
  if (stored && stored.uidValidity === uidValidity) candidates.push(stored.lastSeenUid);

  const resumeFrom = Math.max(...candidates);
  if (resumeFrom <= 0 || resumeFrom > freshBaseline) return freshBaseline;
  return resumeFrom;
}
