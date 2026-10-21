/**
 * Minimal Google Calendar API v3 client for one impersonated user.
 *
 * Tokens come from the same service-account / domain-wide-delegation path as
 * Gmail (OAuthService.mintServiceAccountToken), with the calendar scope. The
 * Admin console entry for the service account's client ID must list
 * https://www.googleapis.com/auth/calendar, and the Calendar API must be
 * enabled in the key's Cloud project.
 */

import OAuthService from '../services/oauth.service.js';
import type { OAuth2Config } from '../types/index.js';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

const API = 'https://www.googleapis.com/calendar/v3';

export type AccessRole = 'freeBusyReader' | 'reader' | 'writer' | 'owner';

export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  summaryOverride?: string;
  description?: string;
  timeZone?: string;
  accessRole: AccessRole;
  primary?: boolean;
}

export interface GoogleEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
}

export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  attendees?: GoogleAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  htmlLink?: string;
  hangoutLink?: string;
  recurringEventId?: string;
  recurrence?: string[];
  iCalUID?: string;
  transparency?: 'opaque' | 'transparent';
  visibility?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

/** Writable event fields (a subset of the API resource). */
export type GoogleEventInput = Partial<
  Omit<GoogleEvent, 'id' | 'htmlLink' | 'hangoutLink' | 'conferenceData'>
> & {
  conferenceData?: unknown;
  reminders?: { useDefault: boolean; overrides?: { method: 'popup' | 'email'; minutes: number }[] };
};

export type SendUpdates = 'all' | 'externalOnly' | 'none';

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export default class GoogleCalendarClient {
  private token: { value: string; expiresAt: number } | undefined;

  private pending: Promise<string> | undefined;

  constructor(private readonly oauth2: OAuth2Config) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    // Concurrent calls share one token request.
    this.pending ??= OAuthService.mintServiceAccountToken({
      ...this.oauth2,
      scopes: [CALENDAR_SCOPE],
    })
      .then(({ accessToken, expiresIn }) => {
        this.token = { value: accessToken, expiresAt: Date.now() + expiresIn * 1000 };
        return accessToken;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        // not JSON — keep the raw body
      }
      throw new Error(
        `Google Calendar ${method} ${url.pathname} failed (${response.status}): ${message}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async listCalendars(): Promise<GoogleCalendarEntry[]> {
    const items: GoogleCalendarEntry[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<{ items?: GoogleCalendarEntry[]; nextPageToken?: string }>(
        'GET',
        '/users/me/calendarList',
        { query: { maxResults: 250, pageToken } },
      );
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  }

  async listEvents(
    calendarId: string,
    opts: { timeMin: string; timeMax: string; query?: string; limit: number },
  ): Promise<GoogleEvent[]> {
    const items: GoogleEvent[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        'GET',
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          query: {
            timeMin: opts.timeMin,
            timeMax: opts.timeMax,
            q: opts.query,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: Math.min(250, opts.limit - items.length),
            pageToken,
          },
        },
      );
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && items.length < opts.limit);
    return items;
  }

  async getEvent(calendarId: string, eventId: string): Promise<GoogleEvent> {
    return this.request(
      'GET',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  }

  async insertEvent(
    calendarId: string,
    event: GoogleEventInput,
    sendUpdates: SendUpdates,
  ): Promise<GoogleEvent> {
    return this.request('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: { sendUpdates, conferenceDataVersion: event.conferenceData ? 1 : undefined },
      body: event,
    });
  }

  /** Import by iCalUID — re-importing the same UID updates instead of duplicating. */
  async importEvent(calendarId: string, event: GoogleEventInput): Promise<GoogleEvent> {
    return this.request('POST', `/calendars/${encodeURIComponent(calendarId)}/events/import`, {
      body: event,
    });
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: GoogleEventInput,
    sendUpdates: SendUpdates,
  ): Promise<GoogleEvent> {
    return this.request(
      'PATCH',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        query: { sendUpdates, conferenceDataVersion: patch.conferenceData ? 1 : undefined },
        body: patch,
      },
    );
  }

  async deleteEvent(calendarId: string, eventId: string, sendUpdates: SendUpdates): Promise<void> {
    await this.request(
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { query: { sendUpdates } },
    );
  }

  async freeBusy(
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<
    Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }>
  > {
    const result = await this.request<{
      calendars?: Record<
        string,
        { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }
      >;
    }>('POST', '/freeBusy', {
      body: { timeMin, timeMax, items: calendarIds.map((id) => ({ id })) },
    });
    return result.calendars ?? {};
  }

  async insertCalendar(
    summary: string,
    timeZone?: string,
    description?: string,
  ): Promise<GoogleCalendarEntry> {
    const created = await this.request<{ id: string; summary: string; timeZone?: string }>(
      'POST',
      '/calendars',
      { body: { summary, timeZone, description } },
    );
    return { ...created, accessRole: 'owner' };
  }
}
