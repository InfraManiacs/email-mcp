import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WATCHER_STATE_FILE resolves from XDG state at module load.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'watcher-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;

afterAll(() => {
  rmSync(STATE_HOME, { recursive: true, force: true });
});

const { readWatermark, resolveBaselineUid, writeWatermark } = await import('./watcher-state.js');

describe('watermark persistence', () => {
  it('round-trips a watermark for an account and folder', async () => {
    await writeWatermark('work', 'INBOX', '42', 1200);
    const stored = await readWatermark('work', 'INBOX');
    expect(stored).toMatchObject({ uidValidity: '42', lastSeenUid: 1200 });
  });

  it('keeps folders and accounts separate', async () => {
    await writeWatermark('work', 'Archive', '42', 7);
    await writeWatermark('personal', 'INBOX', '99', 3);
    expect((await readWatermark('work', 'INBOX'))?.lastSeenUid).toBe(1200);
    expect((await readWatermark('work', 'Archive'))?.lastSeenUid).toBe(7);
    expect((await readWatermark('personal', 'INBOX'))?.lastSeenUid).toBe(3);
  });

  it('returns undefined for a folder never watched', async () => {
    expect(await readWatermark('work', 'Nope')).toBeUndefined();
  });

  it('overwrites rather than appends on the next advance', async () => {
    await writeWatermark('work', 'INBOX', '42', 1300);
    expect((await readWatermark('work', 'INBOX'))?.lastSeenUid).toBe(1300);
  });
});

describe('resolveBaselineUid', () => {
  const base = { uidValidity: '42', uidNext: 1001 };

  // The bug this exists to fix: a restart re-baselined to UIDNEXT, so mail
  // that arrived while the process was down was never reported.
  it('resumes from the stored watermark after a restart', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemoryLastSeenUid: 0,
        stored: { uidValidity: '42', lastSeenUid: 900, updatedAt: 'x' },
      }),
    ).toBe(900);
  });

  it('baselines to uidNext-1 the first time a folder is watched', () => {
    expect(resolveBaselineUid({ ...base, inMemoryLastSeenUid: 0, stored: undefined })).toBe(1000);
  });

  // A renumbered mailbox makes the stored UID point at an unrelated message.
  it('ignores a watermark recorded under a different UIDVALIDITY', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemoryLastSeenUid: 0,
        stored: { uidValidity: '7', lastSeenUid: 900, updatedAt: 'x' },
      }),
    ).toBe(1000);
  });

  // Same gap, reconnect scope: the in-memory watermark must not be discarded
  // in favour of the server's current UIDNEXT.
  it('keeps the in-memory watermark across a reconnect', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemoryLastSeenUid: 950,
        stored: { uidValidity: '42', lastSeenUid: 900, updatedAt: 'x' },
      }),
    ).toBe(950);
  });

  it('takes whichever of memory and file is further ahead', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemoryLastSeenUid: 800,
        stored: { uidValidity: '42', lastSeenUid: 960, updatedAt: 'x' },
      }),
    ).toBe(960);
  });

  // Going mute is the worst outcome, so an impossible watermark is discarded.
  it('falls back to the baseline when the watermark runs past uidNext', () => {
    expect(
      resolveBaselineUid({
        ...base,
        inMemoryLastSeenUid: 0,
        stored: { uidValidity: '42', lastSeenUid: 99_999, updatedAt: 'x' },
      }),
    ).toBe(1000);
  });

  it('handles an empty mailbox without returning a negative uid', () => {
    expect(
      resolveBaselineUid({
        uidValidity: '42',
        uidNext: 1,
        inMemoryLastSeenUid: 0,
        stored: undefined,
      }),
    ).toBe(0);
  });
});
