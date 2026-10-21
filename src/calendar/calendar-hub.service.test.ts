import type { CalendarSourceConfig } from '../types/index.js';
import CalendarHubService from './calendar-hub.service.js';
import type { GoogleCalendarEntry, GoogleEvent } from './google-calendar.js';

const source = (name: string, readOnly = false): CalendarSourceConfig => ({
  name,
  provider: 'google',
  email: `${name}@example.com`,
  oauth2: { provider: 'google-service-account', clientId: '', clientSecret: '', refreshToken: '' },
  readOnly,
});

const event = (
  id: string,
  start: string,
  end: string,
  extra: Partial<GoogleEvent> = {},
): GoogleEvent => ({
  id,
  summary: id,
  start: { dateTime: start },
  end: { dateTime: end },
  ...extra,
});

function fakeClient(calendars: GoogleCalendarEntry[], events: Record<string, GoogleEvent[]> = {}) {
  return {
    listCalendars: vi.fn(async () => calendars),
    listEvents: vi.fn(async (id: string) => {
      if (id === 'broken') throw new Error('boom');
      return events[id] ?? [];
    }),
    getEvent: vi.fn(),
    insertEvent: vi.fn(
      async (_id: string, body: Partial<GoogleEvent>, _send: string) =>
        ({ id: 'new', ...body }) as GoogleEvent,
    ),
    importEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(async () => undefined),
    freeBusy: vi.fn(async () => ({})),
    insertCalendar: vi.fn(),
  };
}

const work = fakeClient(
  [
    {
      id: 'me@work.com',
      summary: 'me@work.com',
      accessRole: 'owner',
      primary: true,
      timeZone: 'America/Chicago',
    },
    { id: 'agents@group.calendar.google.com', summary: 'Agents', accessRole: 'owner' },
    { id: 'me@gmail.com', summary: 'Personal', accessRole: 'reader' },
    { id: 'broken', summary: 'Broken', accessRole: 'reader' },
  ],
  {
    'me@work.com': [event('standup', '2026-10-22T14:00:00Z', '2026-10-22T14:15:00Z')],
    'me@gmail.com': [event('dentist', '2026-10-22T13:00:00Z', '2026-10-22T14:00:00Z')],
  },
);
const home = fakeClient([
  { id: 'fam@example.com', summary: 'Agents', accessRole: 'writer', primary: true },
]);

function hub(defaultRef?: string) {
  const clients = { work, home } as Record<string, ReturnType<typeof fakeClient>>;
  return new CalendarHubService(
    [source('work'), source('home')],
    defaultRef,
    (s) => clients[s.name] as never,
  );
}

describe('CalendarHubService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists calendars across sources with refs and the default', async () => {
    const { calendars, errors } = await hub().listCalendars();
    expect(errors).toEqual([]);
    expect(calendars.map((c) => [c.ref, c.writable, c.default])).toEqual([
      ['work/me@work.com', true, true],
      ['work/agents@group.calendar.google.com', true, false],
      ['work/me@gmail.com', false, false],
      ['work/broken', false, false],
      ['home/fam@example.com', true, false],
    ]);
  });

  it('uses the configured default calendar', async () => {
    const { calendars } = await hub('work/Agents').listCalendars();
    expect(calendars.find((c) => c.default)?.id).toBe('agents@group.calendar.google.com');
  });

  it('resolves refs, names and source names', async () => {
    const h = hub();
    expect((await h.resolve('work/me@gmail.com')).id).toBe('me@gmail.com');
    expect((await h.resolve('personal')).id).toBe('me@gmail.com');
    expect((await h.resolve('home')).id).toBe('fam@example.com');
    expect((await h.resolve('work/primary')).id).toBe('me@work.com');
    await expect(h.resolve('agents')).rejects.toThrow('matches several calendars');
    await expect(h.resolve('nope')).rejects.toThrow('Unknown calendar "nope"');
    await expect(h.resolve('Personal', { write: true })).rejects.toThrow('read-only');
  });

  it('merges events across calendars and reports per-calendar failures', async () => {
    const result = await hub().listEvents({
      timeMin: '2026-10-22T00:00:00Z',
      timeMax: '2026-10-23T00:00:00Z',
      limit: 50,
    });
    expect(result.events.map((e) => [e.summary, e.calendar])).toEqual([
      ['dentist', 'work/me@gmail.com'],
      ['standup', 'work/me@work.com'],
    ]);
    expect(result.errors).toEqual([{ calendar: 'work/broken', error: 'boom' }]);
  });

  it('creates events on the default calendar in its time zone', async () => {
    const created = await hub().createEvent(
      undefined,
      { summary: 'Sync', start: '2026-10-22T10:00:00', end: '2026-10-22T10:30:00', addMeet: true },
      'none',
    );
    expect(created.calendar).toBe('work/me@work.com');
    const [calendarId, body, send] = work.insertEvent.mock.calls[0] ?? [];
    expect(calendarId).toBe('me@work.com');
    expect(send).toBe('none');
    expect(body).toMatchObject({
      start: { dateTime: '2026-10-22T10:00:00', timeZone: 'America/Chicago' },
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
  });

  it('rejects mixed all-day / timed ranges and half-moves', async () => {
    const h = hub();
    await expect(
      h.createEvent(
        undefined,
        { summary: 'x', start: '2026-10-22', end: '2026-10-22T10:00:00Z' },
        'none',
      ),
    ).rejects.toThrow('both be dates');
    await expect(
      h.updateEvent('work/primary', 'e1', { start: '2026-10-22T10:00:00Z' }, 'none'),
    ).rejects.toThrow('both start and end');
  });

  it('finds free time from merged free/busy', async () => {
    work.freeBusy.mockResolvedValueOnce({
      'me@work.com': { busy: [{ start: '2026-10-22T14:00:00Z', end: '2026-10-22T21:00:00Z' }] },
      'me@gmail.com': { errors: [{ reason: 'notFound' }] },
    });
    const result = await hub().findFreeTime({
      timeMin: '2026-10-22T00:00:00Z',
      timeMax: '2026-10-23T00:00:00Z',
      durationMinutes: 30,
      workdayStart: '09:00',
      workdayEnd: '17:00',
      includeWeekends: false,
      maxResults: 5,
    });
    expect(result.timeZone).toBe('America/Chicago');
    expect(result.slots).toEqual([
      { start: '2026-10-22T16:00:00-05:00', end: '2026-10-22T17:00:00-05:00', minutes: 60 },
    ]);
    expect(result.errors).toEqual([{ calendar: 'work/me@gmail.com', error: 'notFound' }]);
  });
});
