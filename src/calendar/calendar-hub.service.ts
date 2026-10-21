/**
 * The shared calendar: every configured calendar source, merged into one view.
 *
 * Calendars are addressed as "source/calendarId" (e.g. "simstech/primary"),
 * or — for convenience — by a unique calendar ID, a unique name, or a bare
 * source name (its primary calendar). Reads fan out across calendars and
 * report per-calendar failures alongside the results instead of failing the
 * whole call.
 */

import type { CalendarSourceConfig } from '../types/index.js';
import GoogleCalendarClient, {
  type GoogleCalendarEntry,
  type GoogleEvent,
  type GoogleEventInput,
  type GoogleEventTime,
  type SendUpdates,
} from './google-calendar.js';
import { assertTimeZone, findFreeSlots, formatInZone, type Interval, parseClock } from './time.js';

export interface HubCalendar {
  ref: string;
  source: string;
  id: string;
  name: string;
  timeZone?: string;
  access: GoogleCalendarEntry['accessRole'];
  primary: boolean;
  writable: boolean;
  default: boolean;
}

export interface HubEvent {
  calendar: string;
  calendarName: string;
  eventId: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  status?: string;
  location?: string;
  description?: string;
  organizer?: string;
  attendees?: { email: string; name?: string; response?: string; optional?: boolean }[];
  meetingUrl?: string;
  htmlLink?: string;
  recurring: boolean;
  busy: boolean;
}

export interface EventFields {
  summary?: string;
  /** ISO date-time (offset or `timeZone`) or YYYY-MM-DD for all-day. */
  start?: string;
  end?: string;
  timeZone?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  recurrence?: string[];
  addMeet?: boolean;
  busy?: boolean;
  reminderMinutes?: number[];
}

export interface CalendarError {
  calendar: string;
  error: string;
}

interface SourceEntry {
  config: CalendarSourceConfig;
  client: Pick<
    GoogleCalendarClient,
    | 'listCalendars'
    | 'listEvents'
    | 'getEvent'
    | 'insertEvent'
    | 'importEvent'
    | 'patchEvent'
    | 'deleteEvent'
    | 'freeBusy'
    | 'insertCalendar'
  >;
}

type ClientFactory = (source: CalendarSourceConfig) => SourceEntry['client'];

const LIST_TTL_MS = 5 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default class CalendarHubService {
  private readonly sources = new Map<string, SourceEntry>();

  private cache: { at: number; calendars: HubCalendar[]; errors: CalendarError[] } | undefined;

  constructor(
    sources: CalendarSourceConfig[],
    private readonly defaultRef?: string,
    factory: ClientFactory = (source) => new GoogleCalendarClient(source.oauth2),
  ) {
    for (const source of sources)
      this.sources.set(source.name, { config: source, client: factory(source) });
  }

  get enabled(): boolean {
    return this.sources.size > 0;
  }

  // ---------------------------------------------------------------------------
  // Calendars
  // ---------------------------------------------------------------------------

  async listCalendars(
    refresh = false,
  ): Promise<{ calendars: HubCalendar[]; errors: CalendarError[] }> {
    if (!refresh && this.cache && Date.now() - this.cache.at < LIST_TTL_MS) return this.cache;

    const calendars: HubCalendar[] = [];
    const errors: CalendarError[] = [];
    const results = await Promise.allSettled(
      [...this.sources.values()].map(async ({ config, client }) => ({
        config,
        entries: await client.listCalendars(),
      })),
    );
    results.forEach((result, i) => {
      const source = [...this.sources.values()][i]?.config;
      if (!source) return;
      if (result.status === 'rejected') {
        errors.push({ calendar: source.name, error: errorText(result.reason) });
        return;
      }
      const include = source.include?.map((v) => v.toLowerCase());
      for (const entry of result.value.entries) {
        const name = entry.summaryOverride ?? entry.summary;
        if (
          include &&
          !include.includes(entry.id.toLowerCase()) &&
          !include.includes(name.toLowerCase()) &&
          !(entry.primary && include.includes('primary'))
        ) {
          continue;
        }
        calendars.push(this.toHubCalendar(source, entry));
      }
    });

    const defaultCal = this.pickDefault(calendars);
    if (defaultCal) defaultCal.default = true;
    this.cache = { at: Date.now(), calendars, errors };
    return this.cache;
  }

  private toHubCalendar(source: CalendarSourceConfig, entry: GoogleCalendarEntry): HubCalendar {
    return {
      ref: `${source.name}/${entry.id}`,
      source: source.name,
      id: entry.id,
      name: entry.summaryOverride ?? entry.summary,
      timeZone: entry.timeZone,
      access: entry.accessRole,
      primary: entry.primary === true,
      writable: !source.readOnly && (entry.accessRole === 'writer' || entry.accessRole === 'owner'),
      default: false,
    };
  }

  private pickDefault(calendars: HubCalendar[]): HubCalendar | undefined {
    if (this.defaultRef) {
      const configured = this.match(calendars, this.defaultRef);
      if (configured.length === 1) return configured[0];
    }
    return calendars.find((c) => c.primary && c.writable) ?? calendars.find((c) => c.writable);
  }

  /** Candidates for a user-supplied calendar reference, best interpretation first. */
  private match(calendars: HubCalendar[], ref: string): HubCalendar[] {
    const lower = ref.trim().toLowerCase();
    const slash = lower.indexOf('/');
    if (slash > 0) {
      const source = lower.slice(0, slash);
      const rest = lower.slice(slash + 1);
      const inSource = calendars.filter((c) => c.source.toLowerCase() === source);
      if (inSource.length > 0) {
        if (rest === 'primary') return inSource.filter((c) => c.primary);
        const byId = inSource.filter((c) => c.id.toLowerCase() === rest);
        return byId.length > 0 ? byId : inSource.filter((c) => c.name.toLowerCase() === rest);
      }
    }
    const byId = calendars.filter((c) => c.id.toLowerCase() === lower);
    if (byId.length > 0) return byId;
    const byName = calendars.filter((c) => c.name.toLowerCase() === lower);
    if (byName.length > 0) return byName;
    return calendars.filter((c) => c.source.toLowerCase() === lower && c.primary);
  }

  /** Resolve a reference (or the default) to exactly one calendar. */
  async resolve(ref: string | undefined, opts: { write?: boolean } = {}): Promise<HubCalendar> {
    const { calendars, errors } = await this.listCalendars();
    let found: HubCalendar | undefined;
    if (ref === undefined || ref.trim() === '') {
      found = calendars.find((c) => c.default);
      if (!found) {
        throw new Error(
          `No default calendar available${errors.length ? ` (${errors.map((e) => e.error).join('; ')})` : ''}`,
        );
      }
    } else {
      let candidates = this.match(calendars, ref);
      if (candidates.length === 0 && this.cache) {
        // A calendar created or shared since the last listing.
        candidates = this.match((await this.listCalendars(true)).calendars, ref);
      }
      if (candidates.length !== 1) {
        const known = calendars.map((c) => `${c.ref} (${c.name})`).join(', ');
        throw new Error(
          candidates.length === 0
            ? `Unknown calendar "${ref}". Known calendars: ${known}`
            : `"${ref}" matches several calendars: ${candidates.map((c) => c.ref).join(', ')} — use the full ref`,
        );
      }
      found = candidates[0];
    }
    if (!found) throw new Error(`Unknown calendar "${ref}"`);
    if (opts.write && !found.writable) {
      throw new Error(`Calendar ${found.ref} is read-only (access: ${found.access})`);
    }
    return found;
  }

  private client(calendar: HubCalendar): SourceEntry['client'] {
    const entry = this.sources.get(calendar.source);
    if (!entry) throw new Error(`Unknown calendar source "${calendar.source}"`);
    return entry.client;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  async listEvents(opts: {
    calendars?: string[];
    timeMin: string;
    timeMax: string;
    query?: string;
    limit: number;
  }): Promise<{ events: HubEvent[]; errors: CalendarError[]; truncated: boolean }> {
    const { calendars: all, errors: listErrors } = await this.listCalendars();
    const targets =
      opts.calendars && opts.calendars.length > 0
        ? await Promise.all(opts.calendars.map(async (ref) => this.resolve(ref)))
        : all.filter((c) => c.access !== 'freeBusyReader');

    const errors: CalendarError[] = [...listErrors];
    const events: HubEvent[] = [];
    let truncated = false;
    await Promise.all(
      targets.map(async (calendar) => {
        try {
          const items = await this.client(calendar).listEvents(calendar.id, {
            timeMin: opts.timeMin,
            timeMax: opts.timeMax,
            query: opts.query,
            limit: opts.limit,
          });
          if (items.length >= opts.limit) truncated = true;
          for (const item of items) events.push(toHubEvent(calendar, item, false));
        } catch (err) {
          errors.push({ calendar: calendar.ref, error: errorText(err) });
        }
      }),
    );
    events.sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.calendar.localeCompare(b.calendar),
    );
    if (events.length > opts.limit) truncated = true;
    return { events: events.slice(0, opts.limit), errors, truncated };
  }

  async getEvent(ref: string, eventId: string): Promise<HubEvent> {
    const calendar = await this.resolve(ref);
    return toHubEvent(calendar, await this.client(calendar).getEvent(calendar.id, eventId), true);
  }

  async createEvent(
    ref: string | undefined,
    fields: EventFields,
    sendUpdates: SendUpdates,
  ): Promise<HubEvent> {
    const calendar = await this.resolve(ref, { write: true });
    if (!fields.summary || !fields.start || !fields.end) {
      throw new Error('summary, start and end are required');
    }
    const body = toGoogleInput(fields, calendar.timeZone);
    const created = await this.client(calendar).insertEvent(calendar.id, body, sendUpdates);
    return toHubEvent(calendar, created, true);
  }

  async updateEvent(
    ref: string,
    eventId: string,
    fields: EventFields,
    sendUpdates: SendUpdates,
  ): Promise<HubEvent> {
    const calendar = await this.resolve(ref, { write: true });
    if ((fields.start === undefined) !== (fields.end === undefined)) {
      // Moving one end alone silently changes the duration; require both.
      throw new Error('Pass both start and end when changing the time');
    }
    const patch = toGoogleInput(fields, calendar.timeZone);
    const updated = await this.client(calendar).patchEvent(
      calendar.id,
      eventId,
      patch,
      sendUpdates,
    );
    return toHubEvent(calendar, updated, true);
  }

  async deleteEvent(ref: string, eventId: string, sendUpdates: SendUpdates): Promise<HubCalendar> {
    const calendar = await this.resolve(ref, { write: true });
    await this.client(calendar).deleteEvent(calendar.id, eventId, sendUpdates);
    return calendar;
  }

  /** Import an iCalendar event (e.g. from an email invite) by UID — idempotent. */
  async importEvent(
    ref: string | undefined,
    event: {
      uid: string;
      summary: string;
      start: string;
      end: string;
      allDay: boolean;
      description?: string;
      location?: string;
      organizer?: string;
      attendees: string[];
      status?: 'confirmed' | 'tentative' | 'cancelled';
      recurrence?: string[];
    },
  ): Promise<HubEvent> {
    const calendar = await this.resolve(ref, { write: true });
    const time = (value: string): GoogleEventTime =>
      event.allDay ? { date: value.slice(0, 10) } : { dateTime: new Date(value).toISOString() };
    const imported = await this.client(calendar).importEvent(calendar.id, {
      iCalUID: event.uid,
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: time(event.start),
      end: time(event.end),
      status: event.status,
      organizer: event.organizer ? { email: event.organizer } : undefined,
      attendees: event.attendees.map((email) => ({ email })),
      recurrence: event.recurrence?.length ? event.recurrence : undefined,
    });
    return toHubEvent(calendar, imported, true);
  }

  async createCalendar(
    sourceName: string,
    name: string,
    timeZone?: string,
    description?: string,
  ): Promise<HubCalendar> {
    const entry = this.sources.get(sourceName);
    if (!entry) {
      throw new Error(
        `Unknown calendar source "${sourceName}". Sources: ${[...this.sources.keys()].join(', ')}`,
      );
    }
    if (entry.config.readOnly) throw new Error(`Calendar source ${sourceName} is read-only`);
    if (timeZone) assertTimeZone(timeZone);
    const created = await entry.client.insertCalendar(name, timeZone, description);
    this.cache = undefined;
    return this.toHubCalendar(entry.config, created);
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  async findFreeTime(opts: {
    calendars?: string[];
    timeMin: string;
    timeMax: string;
    durationMinutes: number;
    workdayStart: string;
    workdayEnd: string;
    timeZone?: string;
    includeWeekends: boolean;
    maxResults: number;
  }): Promise<{
    timeZone: string;
    checked: string[];
    slots: { start: string; end: string; minutes: number }[];
    errors: CalendarError[];
  }> {
    const { calendars: all, errors: listErrors } = await this.listCalendars();
    const targets =
      opts.calendars && opts.calendars.length > 0
        ? await Promise.all(opts.calendars.map(async (ref) => this.resolve(ref)))
        : all;
    const timeZone =
      opts.timeZone ?? all.find((c) => c.default)?.timeZone ?? targets[0]?.timeZone ?? 'UTC';
    assertTimeZone(timeZone);
    const workdayStart = parseClock(opts.workdayStart);
    const workdayEnd = parseClock(opts.workdayEnd);
    if (workdayEnd <= workdayStart) throw new Error('workday_end must be after workday_start');
    const timeMin = Date.parse(opts.timeMin);
    const timeMax = Date.parse(opts.timeMax);
    if (Number.isNaN(timeMin) || Number.isNaN(timeMax) || timeMax <= timeMin) {
      throw new Error('time_min and time_max must be valid ISO times with time_max after time_min');
    }

    const errors: CalendarError[] = [...listErrors];
    const busy: Interval[] = [];
    const bySource = new Map<string, HubCalendar[]>();
    for (const calendar of targets) {
      bySource.set(calendar.source, [...(bySource.get(calendar.source) ?? []), calendar]);
    }
    await Promise.all(
      [...bySource.values()].flatMap((group) => {
        // The freeBusy API takes at most 50 calendars per query.
        const chunks: HubCalendar[][] = [];
        for (let i = 0; i < group.length; i += 50) chunks.push(group.slice(i, i + 50));
        return chunks.map(async (chunk) => {
          const first = chunk[0];
          if (!first) return;
          try {
            const result = await this.client(first).freeBusy(
              chunk.map((c) => c.id),
              new Date(timeMin).toISOString(),
              new Date(timeMax).toISOString(),
            );
            for (const calendar of chunk) {
              const entry = result[calendar.id];
              if (entry?.errors?.length) {
                errors.push({
                  calendar: calendar.ref,
                  error: entry.errors.map((e) => e.reason).join(', '),
                });
              }
              for (const b of entry?.busy ?? [])
                busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
            }
          } catch (err) {
            for (const calendar of chunk)
              errors.push({ calendar: calendar.ref, error: errorText(err) });
          }
        });
      }),
    );

    const slots = findFreeSlots(busy, {
      timeMin,
      timeMax,
      durationMinutes: opts.durationMinutes,
      timeZone,
      workdayStart,
      workdayEnd,
      includeWeekends: opts.includeWeekends,
      maxResults: opts.maxResults,
    });
    return {
      timeZone,
      checked: targets.map((c) => c.ref),
      slots: slots.map((s) => ({
        start: formatInZone(s.start, timeZone),
        end: formatInZone(s.end, timeZone),
        minutes: Math.round((s.end - s.start) / 60_000),
      })),
      errors,
    };
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toHubEvent(calendar: HubCalendar, event: GoogleEvent, full: boolean): HubEvent {
  const allDay = event.start.date !== undefined;
  const meetingUrl =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  const organizer = event.organizer?.email
    ? event.organizer.displayName
      ? `${event.organizer.displayName} <${event.organizer.email}>`
      : event.organizer.email
    : undefined;
  return {
    calendar: calendar.ref,
    calendarName: calendar.name,
    eventId: event.id,
    summary: event.summary ?? '(no title)',
    start: event.start.dateTime ?? event.start.date ?? '',
    end: event.end.dateTime ?? event.end.date ?? '',
    allDay,
    status: event.status,
    location: event.location,
    description: full ? event.description : truncate(event.description, 300),
    organizer,
    attendees: event.attendees?.map((a) => ({
      email: a.email,
      name: a.displayName,
      response: a.responseStatus,
      optional: a.optional,
    })),
    meetingUrl,
    htmlLink: full ? event.htmlLink : undefined,
    recurring: event.recurringEventId !== undefined || (event.recurrence?.length ?? 0) > 0,
    busy: event.transparency !== 'transparent',
  };
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function toEventTime(value: string, timeZone: string | undefined): GoogleEventTime {
  if (DATE_ONLY.test(value)) return { date: value };
  if (Number.isNaN(Date.parse(value))) throw new Error(`Invalid date/time "${value}"`);
  return timeZone ? { dateTime: value, timeZone } : { dateTime: value };
}

function toGoogleInput(
  fields: EventFields,
  calendarTimeZone: string | undefined,
): GoogleEventInput {
  if (fields.timeZone) assertTimeZone(fields.timeZone);
  const zone = fields.timeZone ?? calendarTimeZone;
  const input: GoogleEventInput = {};
  if (fields.summary !== undefined) input.summary = fields.summary;
  if (fields.description !== undefined) input.description = fields.description;
  if (fields.location !== undefined) input.location = fields.location;
  if (fields.start !== undefined) input.start = toEventTime(fields.start, zone);
  if (fields.end !== undefined) input.end = toEventTime(fields.end, zone);
  if (
    input.start &&
    input.end &&
    (input.start.date === undefined) !== (input.end.date === undefined)
  ) {
    throw new Error('start and end must both be dates (all-day) or both be date-times');
  }
  if (fields.attendees !== undefined)
    input.attendees = fields.attendees.map((email) => ({ email }));
  if (fields.recurrence !== undefined) input.recurrence = fields.recurrence;
  if (fields.busy !== undefined) input.transparency = fields.busy ? 'opaque' : 'transparent';
  if (fields.reminderMinutes !== undefined) {
    input.reminders = {
      useDefault: false,
      overrides: fields.reminderMinutes.map((minutes) => ({ method: 'popup' as const, minutes })),
    };
  }
  if (fields.addMeet) {
    input.conferenceData = {
      createRequest: {
        requestId: `hub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }
  return input;
}
