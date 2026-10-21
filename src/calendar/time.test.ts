import { findFreeSlots, formatInZone, mergeIntervals, parseClock, zonedToUtc } from './time.js';

const at = (iso: string): number => Date.parse(iso);

describe('time helpers', () => {
  it('converts wall-clock times across DST', () => {
    // Chicago: CDT (-05:00) before 2026-11-01, CST (-06:00) after.
    expect(new Date(zonedToUtc(2026, 10, 30, 9 * 60, 'America/Chicago')).toISOString()).toBe(
      '2026-10-30T14:00:00.000Z',
    );
    expect(new Date(zonedToUtc(2026, 11, 2, 9 * 60, 'America/Chicago')).toISOString()).toBe(
      '2026-11-02T15:00:00.000Z',
    );
  });

  it('formats with the zone offset', () => {
    expect(formatInZone(at('2026-10-22T14:00:00Z'), 'America/Chicago')).toBe(
      '2026-10-22T09:00:00-05:00',
    );
    expect(formatInZone(at('2026-10-22T14:00:00Z'), 'Asia/Kolkata')).toBe(
      '2026-10-22T19:30:00+05:30',
    );
  });

  it('parses clock times', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('24:00')).toBe(1440);
    expect(() => parseClock('9am')).toThrow('HH:MM');
    expect(() => parseClock('24:30')).toThrow();
  });

  it('merges overlapping and touching intervals', () => {
    expect(
      mergeIntervals([
        { start: 5, end: 8 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
        { start: 6, end: 7 },
      ]),
    ).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 8 },
    ]);
  });
});

describe('findFreeSlots', () => {
  const base = {
    durationMinutes: 30,
    timeZone: 'America/Chicago',
    workdayStart: 9 * 60,
    workdayEnd: 17 * 60,
    includeWeekends: false,
    maxResults: 10,
  };

  it('returns the gaps between busy blocks inside working hours', () => {
    // Thursday 2026-10-22, 09:00–17:00 CDT = 14:00–22:00Z.
    const slots = findFreeSlots(
      [
        { start: at('2026-10-22T15:00:00Z'), end: at('2026-10-22T16:00:00Z') },
        { start: at('2026-10-22T16:10:00Z'), end: at('2026-10-22T21:00:00Z') },
      ],
      { ...base, timeMin: at('2026-10-22T00:00:00Z'), timeMax: at('2026-10-23T00:00:00Z') },
    );
    expect(
      slots.map((s) => [new Date(s.start).toISOString(), new Date(s.end).toISOString()]),
    ).toEqual([
      ['2026-10-22T14:00:00.000Z', '2026-10-22T15:00:00.000Z'],
      ['2026-10-22T21:00:00.000Z', '2026-10-22T22:00:00.000Z'],
    ]);
  });

  it('skips weekends unless asked and starts no earlier than timeMin', () => {
    // Fri 2026-10-23 15:30 CDT → Mon 2026-10-26 end of day.
    const range = { timeMin: at('2026-10-23T20:30:00Z'), timeMax: at('2026-10-27T05:00:00Z') };
    const weekdays = findFreeSlots([], { ...base, ...range });
    expect(weekdays.map((s) => formatInZone(s.start, 'America/Chicago'))).toEqual([
      '2026-10-23T15:30:00-05:00',
      '2026-10-26T09:00:00-05:00',
    ]);
    expect(findFreeSlots([], { ...base, ...range, includeWeekends: true })).toHaveLength(4);
  });

  it('honours maxResults', () => {
    const slots = findFreeSlots([], {
      ...base,
      timeMin: at('2026-10-19T00:00:00Z'),
      timeMax: at('2026-11-30T00:00:00Z'),
      maxResults: 3,
    });
    expect(slots).toHaveLength(3);
  });
});
