/**
 * MCP Tools: shared calendar (server-side, across every [[calendars]] source)
 *
 * - list_shared_calendars        — every calendar agents can see, with refs
 * - list_calendar_events         — merged events across calendars in a range
 * - get_calendar_event           — one event in full
 * - find_free_time               — free slots across calendars in working hours
 * - create_calendar_event        — (write) new event, optional Meet link
 * - update_calendar_event        — (write) patch an event
 * - delete_calendar_event        — (write) delete an event
 * - create_shared_calendar       — (write) new calendar owned by a source
 * - add_email_to_shared_calendar — (write) import an email's ICS invite
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type CalendarHubService from '../calendar/calendar-hub.service.js';
import type { EventFields } from '../calendar/calendar-hub.service.js';
import type CalendarService from '../services/calendar.service.js';
import type ImapService from '../services/imap.service.js';

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const calendarRef = z
  .string()
  .describe(
    'Calendar ref from list_shared_calendars ("source/calendarId"); a unique calendar name or a source name (its primary calendar) also works',
  );

const sendUpdates = z
  .enum(['none', 'all', 'externalOnly'])
  .default('none')
  .describe('Email invitations/updates to attendees: none (default), all, or externalOnly');

const EventFieldsSchema = z.object({
  summary: z.string().min(1).describe('Event title'),
  start: z
    .string()
    .describe(
      'Start: ISO date-time with offset (2026-10-22T14:00:00-05:00), a local date-time plus time_zone, or YYYY-MM-DD for all-day',
    ),
  end: z.string().describe('End, same format as start (all-day end dates are exclusive)'),
  time_zone: z
    .string()
    .optional()
    .describe('IANA zone for date-times without an offset (default: the calendar zone)'),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string().email()).optional().describe('Attendee email addresses'),
  recurrence: z
    .array(z.string())
    .optional()
    .describe('RFC 5545 lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10"]'),
  add_meet: z.boolean().optional().describe('Attach a new Google Meet link'),
  busy: z.boolean().optional().describe('Show as busy (default true); false = free/transparent'),
  reminder_minutes: z
    .array(z.number().int().min(0).max(40320))
    .optional()
    .describe('Popup reminders, minutes before start (replaces the calendar defaults)'),
});

const toFields = (input: Partial<z.infer<typeof EventFieldsSchema>>): EventFields => ({
  summary: input.summary,
  start: input.start,
  end: input.end,
  timeZone: input.time_zone,
  description: input.description,
  location: input.location,
  attendees: input.attendees,
  recurrence: input.recurrence,
  addMeet: input.add_meet,
  busy: input.busy,
  reminderMinutes: input.reminder_minutes,
});

export function registerSharedCalendarReadTools(server: McpServer, hub: CalendarHubService): void {
  server.registerTool(
    'list_shared_calendars',
    {
      title: 'List shared calendars',
      description:
        "List every calendar in the shared calendar hub, across all connected calendar accounts. Returns each calendar's ref (pass it as `calendar` to the other calendar tools), name, time zone, access and whether agents can write to it. The calendar marked default receives new events when no calendar is named. Call this first.",
      inputSchema: z.object({
        refresh: z.boolean().default(false).describe('Bypass the 5-minute calendar list cache'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ refresh }) => json(await hub.listCalendars(refresh)),
  );

  server.registerTool(
    'list_calendar_events',
    {
      title: 'List calendar events',
      description:
        'List events across the shared calendars (all readable calendars by default), merged and sorted by start time. Recurring events are expanded into instances. Use `query` for free-text search. Per-calendar failures are reported in `errors` without failing the call.',
      inputSchema: z.object({
        calendars: z
          .array(z.string())
          .optional()
          .describe('Calendar refs to include (default: all readable calendars)'),
        time_min: z.string().optional().describe('Range start, ISO 8601 (default: now)'),
        time_max: z
          .string()
          .optional()
          .describe('Range end, ISO 8601 (default: time_min + 7 days)'),
        query: z
          .string()
          .optional()
          .describe('Free-text search over title, description, location, attendees'),
        limit: z.coerce.number().int().min(1).max(500).default(50),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ calendars, time_min: timeMin, time_max: timeMax, query, limit }) => {
      const min = parseTime(timeMin, Date.now(), 'time_min');
      const max = parseTime(timeMax, min + 7 * 86_400_000, 'time_max');
      return json(
        await hub.listEvents({
          calendars,
          timeMin: new Date(min).toISOString(),
          timeMax: new Date(max).toISOString(),
          query,
          limit,
        }),
      );
    },
  );

  server.registerTool(
    'get_calendar_event',
    {
      title: 'Get calendar event',
      description: 'Get one event in full (description, attendees and responses, meeting link).',
      inputSchema: z.object({
        calendar: calendarRef,
        event_id: z.string().describe('eventId from list_calendar_events'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ calendar, event_id: eventId }) => json(await hub.getEvent(calendar, eventId)),
  );

  server.registerTool(
    'find_free_time',
    {
      title: 'Find free time',
      description:
        'Find free windows across the shared calendars (all by default, including free/busy-only calendars) within working hours. Each slot is a whole free gap of at least duration_minutes; book any start inside it.',
      inputSchema: z.object({
        duration_minutes: z.coerce.number().int().min(5).max(1440).default(30),
        calendars: z.array(z.string()).optional().describe('Calendar refs to check (default: all)'),
        time_min: z.string().optional().describe('Search start, ISO 8601 (default: now)'),
        time_max: z
          .string()
          .optional()
          .describe('Search end, ISO 8601 (default: time_min + 7 days)'),
        workday_start: z.string().default('09:00').describe('HH:MM local time'),
        workday_end: z.string().default('17:00').describe('HH:MM local time'),
        time_zone: z
          .string()
          .optional()
          .describe('IANA zone for working hours and results (default: the default calendar zone)'),
        include_weekends: z.boolean().default(false),
        max_results: z.coerce.number().int().min(1).max(100).default(10),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      const min = parseTime(input.time_min, Date.now(), 'time_min');
      const max = parseTime(input.time_max, min + 7 * 86_400_000, 'time_max');
      return json(
        await hub.findFreeTime({
          calendars: input.calendars,
          timeMin: new Date(min).toISOString(),
          timeMax: new Date(max).toISOString(),
          durationMinutes: input.duration_minutes,
          workdayStart: input.workday_start,
          workdayEnd: input.workday_end,
          timeZone: input.time_zone,
          includeWeekends: input.include_weekends,
          maxResults: input.max_results,
        }),
      );
    },
  );
}

export function registerSharedCalendarWriteTools(
  server: McpServer,
  hub: CalendarHubService,
  imapService: ImapService,
  calendarService: CalendarService,
): void {
  server.registerTool(
    'create_calendar_event',
    {
      title: 'Create calendar event',
      description:
        'Create an event on a shared calendar (the default calendar when `calendar` is omitted). Attendees are only emailed when send_updates is "all" or "externalOnly".',
      inputSchema: EventFieldsSchema.extend({
        calendar: calendarRef.optional(),
        send_updates: sendUpdates,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ calendar, send_updates: send, ...input }) =>
      json(await hub.createEvent(calendar, toFields(input), send)),
  );

  server.registerTool(
    'update_calendar_event',
    {
      title: 'Update calendar event',
      description:
        'Change fields of an existing event; omitted fields are left as they are. Pass both start and end to move it. `attendees` replaces the whole list.',
      inputSchema: EventFieldsSchema.partial().extend({
        calendar: calendarRef,
        event_id: z.string(),
        send_updates: sendUpdates,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ calendar, event_id: eventId, send_updates: send, ...input }) =>
      json(await hub.updateEvent(calendar, eventId, toFields(input), send)),
  );

  server.registerTool(
    'delete_calendar_event',
    {
      title: 'Delete calendar event',
      description:
        'Delete an event (for a recurring series, pass the series event id to delete all of it).',
      inputSchema: z.object({
        calendar: calendarRef,
        event_id: z.string(),
        send_updates: sendUpdates,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ calendar, event_id: eventId, send_updates: send }) => {
      const cal = await hub.deleteEvent(calendar, eventId, send);
      return json({ deleted: true, calendar: cal.ref, eventId });
    },
  );

  server.registerTool(
    'create_shared_calendar',
    {
      title: 'Create shared calendar',
      description:
        'Create a new calendar owned by a calendar source account (e.g. a team or project calendar). Share it with people from Google Calendar.',
      inputSchema: z.object({
        source: z.string().describe('Calendar source name (the part before "/" in calendar refs)'),
        name: z.string().min(1),
        time_zone: z.string().optional().describe('IANA zone (default: the account zone)'),
        description: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ source, name, time_zone: timeZone, description }) =>
      json(await hub.createCalendar(source, name, timeZone, description)),
  );

  server.registerTool(
    'add_email_to_shared_calendar',
    {
      title: 'Add email invite to shared calendar',
      description:
        'Import the calendar invite (ICS) attached to an email into a shared calendar. Importing the same invite again updates the event instead of duplicating it. Does not RSVP.',
      inputSchema: z.object({
        account: z.string().describe('Email account name'),
        email_id: z.string().describe('Email UID'),
        mailbox: z.string().default('INBOX'),
        calendar: calendarRef.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ account, email_id: emailId, mailbox, calendar }) => {
      const parts = await imapService.getCalendarParts(account, mailbox, emailId);
      const events = calendarService
        .extractFromParts(parts)
        .filter((e) => e.uid && e.start && e.end);
      if (events.length === 0) {
        return json({
          imported: [],
          message: 'No calendar invite (ICS) with a UID and times found in this email',
        });
      }
      const imported = [];
      for (const event of events) {
        const localDate = (iso: string): string => {
          const d = new Date(iso);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        imported.push(
          await hub.importEvent(calendar, {
            uid: event.uid,
            summary: event.summary,
            start: event.allDay ? localDate(event.start) : event.start,
            end: event.allDay ? localDate(event.end) : event.end,
            allDay: event.allDay === true,
            description: event.description,
            location: event.location,
            organizer: event.organizer?.address,
            attendees: event.attendees.map((a) => a.address),
            status: event.status.toLowerCase() as 'confirmed' | 'tentative' | 'cancelled',
            recurrence: event.recurrence
              ?.split('\n')
              .filter((line) => /^(RRULE|EXDATE|RDATE):/.test(line)),
          }),
        );
      }
      return json({ imported });
    },
  );
}

function parseTime(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${name} is not a valid ISO 8601 time: "${value}"`);
  return ms;
}
