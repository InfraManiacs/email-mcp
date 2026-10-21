/**
 * Time-zone arithmetic and free-slot search for the shared calendar.
 *
 * Only Intl is used — no tz database dependency. Working hours are wall-clock
 * times in an IANA zone, converted per day so DST changes land correctly.
 */

export interface Interval {
  start: number;
  end: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, fmt);
  }
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** Throws a readable error for an unknown IANA zone. */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`Unknown time zone "${timeZone}" (use an IANA name like America/Chicago)`);
  }
}

/** Minutes the zone is ahead of UTC at `date`. */
function offsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** The UTC instant of a wall-clock time in `timeZone`. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const first = offsetMinutes(new Date(guess), timeZone);
  const t = guess - first * 60_000;
  const second = offsetMinutes(new Date(t), timeZone);
  return second === first ? t : guess - second * 60_000;
}

/** ISO 8601 with the zone's offset, e.g. 2026-10-22T09:00:00-05:00. */
export function formatInZone(ms: number, timeZone: string): string {
  const date = new Date(ms);
  const p = zonedParts(date, timeZone);
  const off = offsetMinutes(date, timeZone);
  const pad = (n: number | undefined, w = 2): string => String(n ?? 0).padStart(w, '0');
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** "09:30" → 570. */
export function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 24 || minutes > 59 || hours * 60 + minutes > 1440) {
    throw new Error(`Invalid time "${value}" (expected HH:MM)`);
  }
  return hours * 60 + minutes;
}

/** Sort and merge overlapping or touching intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export interface FreeSlotOptions {
  timeMin: number;
  timeMax: number;
  durationMinutes: number;
  timeZone: string;
  /** Minutes after local midnight. */
  workdayStart: number;
  workdayEnd: number;
  includeWeekends: boolean;
  maxResults: number;
}

/**
 * Free windows of at least `durationMinutes` inside working hours, given busy
 * intervals. Each returned window is a whole gap; callers pick a start in it.
 */
export function findFreeSlots(busy: Interval[], opts: FreeSlotOptions): Interval[] {
  const merged = mergeIntervals(busy);
  const minLength = opts.durationMinutes * 60_000;
  const slots: Interval[] = [];

  const first = zonedParts(new Date(opts.timeMin), opts.timeZone);
  let cursor = Date.UTC(first.year ?? 0, (first.month ?? 1) - 1, first.day ?? 1);

  // Each iteration is one local calendar day; ~2 years is a sane upper bound.
  for (let guard = 0; guard < 800 && slots.length < opts.maxResults; guard += 1) {
    const day = new Date(cursor);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    cursor = Date.UTC(y, m - 1, d + 1);

    const dayStart = zonedToUtc(y, m, d, 0, opts.timeZone);
    if (dayStart >= opts.timeMax) break;
    const weekday = day.getUTCDay();
    if (!opts.includeWeekends && (weekday === 0 || weekday === 6)) continue;

    const windowStart = Math.max(
      zonedToUtc(y, m, d, opts.workdayStart, opts.timeZone),
      opts.timeMin,
    );
    const windowEnd = Math.min(zonedToUtc(y, m, d, opts.workdayEnd, opts.timeZone), opts.timeMax);
    if (windowEnd - windowStart < minLength) continue;

    let free = windowStart;
    for (const b of merged) {
      if (b.end <= free) continue;
      if (b.start >= windowEnd) break;
      if (b.start - free >= minLength) slots.push({ start: free, end: b.start });
      free = Math.max(free, b.end);
      if (slots.length >= opts.maxResults) break;
    }
    if (slots.length < opts.maxResults && windowEnd - free >= minLength) {
      slots.push({ start: free, end: windowEnd });
    }
  }
  return slots.slice(0, opts.maxResults);
}
