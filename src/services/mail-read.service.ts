/**
 * Read-model facade in front of ImapService and the local mirror.
 *
 * Every read tool goes through this service; writes stay on ImapService and
 * SmtpService (and emit `email:changed` so the mirror resynchronizes). Reads
 * are correctness-first:
 *
 * 1. A mirror reconciled within the debounce window (and not marked dirty) is
 *    served directly — this collapses the burst of reads inside one agent
 *    turn to zero network round trips.
 * 2. Otherwise one STATUS round trip compares the server's UIDVALIDITY /
 *    UIDNEXT / HIGHESTMODSEQ / MESSAGES against the stored watermarks — the
 *    IMAP equivalent of a conditional request. Unchanged ⇒ serve the mirror.
 * 3. Changed ⇒ await the sync, bounded; past the bound the mirror is served
 *    marked `stale: true` while the sync finishes in the background.
 * 4. IMAP unreachable ⇒ serve the mirror marked `offline: true` (RFC 5861
 *    stale-if-error, and the offline mode the mirror exists for).
 *
 * Mailboxes the mirror has never synced are served live and warmed in the
 * background. With the cache disabled the facade is a pure pass-through.
 */

import type CacheStore from '../cache/store.js';
import type { CachedMessage, MessageFilters } from '../cache/store.js';
import { MAX_CACHED_BODY_BYTES } from '../cache/store.js';
import type SyncEngine from '../cache/sync-engine.js';
import type { Email, EmailMeta, PaginatedResult } from '../types/index.js';
import { stripHtml } from '../utils/html.js';
import type ImapService from './imap.service.js';
import { extractAttachments, messageToEmailMeta, parseAddresses } from './imap.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a read was answered from, surfaced to the MCP client (additive). */
export interface CacheMarker {
  source: 'cache';
  /** Set when a change is known but the bounded sync wait expired. */
  stale?: true;
  /** Set when the IMAP server was unreachable and the mirror answered. */
  offline?: true;
}

export type CachedList = PaginatedResult<EmailMeta> & { cache?: CacheMarker };

/** Process-lifetime counters, surfaced via check_health / cache status. */
export interface MailReadMetrics {
  /** Reads served from the mirror without any network round trip. */
  hits: number;
  /** Reads served from the mirror after a STATUS confirmed it current. */
  validatedHits: number;
  /** Reads that triggered a blocking sync because the mirror was behind. */
  syncedReads: number;
  /** Reads served stale because the bounded sync wait expired. */
  staleServes: number;
  /** Reads served from the mirror because IMAP was unreachable or failing. */
  offlineServes: number;
  /** Reads that fell through to the live path. */
  liveFallbacks: number;
  /**
   * STATUS probes that disagreed with the mirror — each one is a change the
   * event pipeline missed, so a growing number means invalidation is broken.
   */
  revalidationsChanged: number;
}

interface MailReadOptions {
  /** Reads within this window of the last reconcile skip revalidation. */
  debounceMs?: number;
  /** How long a read waits for a triggered sync before serving stale. */
  syncWaitMs?: number;
}

type Revalidation = { kind: 'live' } | { kind: 'cache'; uidValidity: string; marker: CacheMarker };

const DEFAULT_DEBOUNCE_MS = 10_000;
const DEFAULT_SYNC_WAIT_MS = 5_000;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Map a mirrored row to the live `EmailMeta` shape.
 *
 * Reuses the live mapper on the stored envelope so both paths stay parity:
 * the envelope JSON round-trips dates as ISO strings, which the mapper
 * already handles.
 */
function toEmailMeta(msg: CachedMessage): EmailMeta {
  const meta = messageToEmailMeta({
    uid: msg.uid,
    envelope: msg.envelope,
    flags: msg.flags,
    bodyStructure: msg.bodyStructure,
  });

  if (msg.preview !== undefined) meta.preview = msg.preview;
  // Rows synced without a bodyStructure still know they carry attachments.
  if (msg.hasAttachments) meta.hasAttachments = true;
  return meta;
}

/**
 * Assemble the full live `Email` shape from a mirrored row.
 *
 * Only callable for rows that hold a body and headers — the hit condition in
 * `getEmail` — since both are part of the public response shape.
 */
function toEmail(msg: CachedMessage): Email {
  const meta = toEmailMeta(msg);
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;
  const headers = msg.headers ?? {};

  return {
    ...meta,
    cc: parseAddresses(envelope.cc as { name?: string; address?: string }[] | undefined),
    bcc: parseAddresses(envelope.bcc as { name?: string; address?: string }[] | undefined),
    bodyText: msg.bodySubtype === 'html' ? undefined : msg.bodyText,
    bodyHtml: msg.bodySubtype === 'html' ? msg.bodyText : undefined,
    messageId: (envelope.messageId as string) ?? '',
    inReplyTo: (envelope.inReplyTo as string) ?? undefined,
    references: headers.references?.split(/\s+/).filter(Boolean),
    attachments: extractAttachments(msg.bodyStructure),
    headers,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class MailReadService {
  private readonly debounceMs: number;

  private readonly syncWaitMs: number;

  private metrics: MailReadMetrics = {
    hits: 0,
    validatedHits: 0,
    syncedReads: 0,
    staleServes: 0,
    offlineServes: 0,
    liveFallbacks: 0,
    revalidationsChanged: 0,
  };

  constructor(
    private readonly imapService: ImapService,
    private readonly store?: CacheStore,
    private readonly syncEngine?: SyncEngine,
    options: MailReadOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.syncWaitMs = options.syncWaitMs ?? DEFAULT_SYNC_WAIT_MS;
  }

  getMetrics(): Readonly<MailReadMetrics> {
    return this.metrics;
  }

  // -------------------------------------------------------------------------
  // Freshness protocol
  // -------------------------------------------------------------------------

  /**
   * Decide whether the mirror may answer for `mailbox`, revalidating or
   * resynchronizing as needed. Never throws: every failure path degrades to
   * either a marked cache serve or the live path.
   */
  private async revalidate(account: string, mailbox: string): Promise<Revalidation> {
    const store = this.store;
    const engine = this.syncEngine;
    if (!store || !engine) return { kind: 'live' };

    const state = store.getMailboxState(account, mailbox);
    if (!state || state.lastSyncedAt === undefined) {
      // Never mirrored: answer live now, warm the mirror for next time.
      // syncMailbox never rejects by contract; the catch guards the rule that
      // no fire-and-forget promise goes unhandled.
      void engine.syncMailbox(account, mailbox).catch(() => {});
      this.metrics.liveFallbacks += 1;
      return { kind: 'live' };
    }

    const dirty = engine.isDirty(account, mailbox);
    if (!dirty && Date.now() - state.lastSyncedAt < this.debounceMs) {
      this.metrics.hits += 1;
      return { kind: 'cache', uidValidity: state.uidValidity, marker: { source: 'cache' } };
    }

    if (!dirty) {
      let status: Awaited<ReturnType<ImapService['getMailboxStatus']>>;
      try {
        status = await this.imapService.getMailboxStatus(account, mailbox);
      } catch {
        this.metrics.offlineServes += 1;
        return {
          kind: 'cache',
          uidValidity: state.uidValidity,
          marker: { source: 'cache', offline: true },
        };
      }

      if (MailReadService.statusUnchanged(state, status)) {
        store.putMailboxState({ ...state, lastSyncedAt: Date.now() });
        this.metrics.validatedHits += 1;
        return { kind: 'cache', uidValidity: state.uidValidity, marker: { source: 'cache' } };
      }
      this.metrics.revalidationsChanged += 1;
    }

    // The mirror is known to be behind: sync, bounded.
    const result = await MailReadService.race(
      engine.syncMailbox(account, mailbox),
      this.syncWaitMs,
    );
    const uidValidity = store.getMailboxState(account, mailbox)?.uidValidity ?? state.uidValidity;

    if (result === 'timeout') {
      this.metrics.staleServes += 1;
      return { kind: 'cache', uidValidity, marker: { source: 'cache', stale: true } };
    }
    if (!result.ok) {
      this.metrics.offlineServes += 1;
      return { kind: 'cache', uidValidity, marker: { source: 'cache', offline: true } };
    }
    this.metrics.syncedReads += 1;
    return { kind: 'cache', uidValidity, marker: { source: 'cache' } };
  }

  /**
   * Compare a STATUS response against the stored watermarks. Absent fields on
   * either side are treated as changed — no evidence is not evidence of
   * freshness.
   */
  private static statusUnchanged(
    state: {
      uidValidity: string;
      uidNext?: number;
      highestModseq?: string;
      totalMessages?: number;
    },
    status: { uidValidity?: string; uidNext?: number; highestModseq?: string; messages?: number },
  ): boolean {
    if (!status.uidValidity || status.uidValidity !== state.uidValidity) return false;
    if (status.uidNext === undefined || state.uidNext === undefined) return false;
    if (status.uidNext !== state.uidNext) return false;
    // MESSAGES moving while UIDNEXT holds still is the expunge tell on
    // servers without CONDSTORE.
    if (status.messages === undefined || state.totalMessages === undefined) return false;
    if (status.messages !== state.totalMessages) return false;
    // HIGHESTMODSEQ is compared only when both sides know it — a flag-only
    // change moves it on CONDSTORE servers.
    if (
      status.highestModseq !== undefined &&
      state.highestModseq !== undefined &&
      status.highestModseq !== state.highestModseq
    ) {
      return false;
    }
    return true;
  }

  private static race<T>(work: Promise<T>, waitMs: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), waitMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listEmails(
    account: string,
    options: Parameters<ImapService['listEmails']>[1] = {},
  ): Promise<CachedList> {
    const store = this.store;
    if (!store) return this.imapService.listEmails(account, options);

    const mailbox = options.mailbox ?? 'INBOX';
    const reval = await this.revalidate(account, mailbox);
    if (reval.kind === 'live') return this.imapService.listEmails(account, options);

    const filters: MessageFilters = {
      since: options.since,
      before: options.before,
      from: options.from,
      subject: options.subject,
      seen: options.seen,
      flagged: options.flagged,
      answered: options.answered,
      hasAttachment: options.hasAttachment,
    };

    try {
      const page = store.listMessages(
        account,
        mailbox,
        reval.uidValidity,
        { page: options.page ?? 1, pageSize: options.pageSize ?? 20 },
        filters,
      );

      return {
        items: page.items.map(toEmailMeta),
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
        hasMore: page.hasMore,
        cache: reval.marker,
      };
    } catch {
      // A broken mirror must never break the tool — answer live.
      this.metrics.liveFallbacks += 1;
      return this.imapService.listEmails(account, options);
    }
  }

  async getEmailFlags(
    account: string,
    emailId: string,
    mailbox = 'INBOX',
  ): ReturnType<ImapService['getEmailFlags']> {
    const store = this.store;
    const uid = Number.parseInt(emailId, 10);
    if (!store || Number.isNaN(uid)) {
      return this.imapService.getEmailFlags(account, emailId, mailbox);
    }

    const reval = await this.revalidate(account, mailbox);
    if (reval.kind === 'cache') {
      try {
        const msg = store.getMessage(account, mailbox, uid, reval.uidValidity);
        if (msg) {
          const envelope = (msg.envelope ?? {}) as { date?: string };
          return {
            seen: msg.seen,
            flagged: msg.flagged,
            answered: msg.answered,
            labels: msg.flags.filter((f) => !f.startsWith('\\')),
            subject: msg.subject ?? '(no subject)',
            from: msg.fromText ?? '',
            date: envelope.date ? new Date(envelope.date).toISOString() : '',
          };
        }
      } catch {
        // Fall through to the live path below.
      }
    }

    // Not mirrored (outside the window, or an uncached mailbox) — live.
    this.metrics.liveFallbacks += 1;
    return this.imapService.getEmailFlags(account, emailId, mailbox);
  }

  // -------------------------------------------------------------------------
  // Single message (body tier)
  // -------------------------------------------------------------------------

  /** In-flight single-message loads, so concurrent get_emails coalesce. */
  private inFlightEmails = new Map<string, Promise<Email>>();

  async getEmail(account: string, emailId: string, mailbox = 'INBOX'): Promise<Email> {
    const uid = Number.parseInt(emailId, 10);
    if (!this.store || Number.isNaN(uid)) {
      return this.imapService.getEmail(account, emailId, mailbox);
    }

    const key = `${account} ${mailbox} ${uid}`;
    const pending = this.inFlightEmails.get(key);
    if (pending) return pending;

    const load = this.loadEmail(account, emailId, mailbox, uid).finally(() => {
      this.inFlightEmails.delete(key);
    });
    this.inFlightEmails.set(key, load);
    return load;
  }

  private async loadEmail(
    account: string,
    emailId: string,
    mailbox: string,
    uid: number,
  ): Promise<Email> {
    const store = this.store as CacheStore;

    const reval = await this.revalidate(account, mailbox);
    if (reval.kind === 'cache') {
      try {
        const msg = store.getMessage(account, mailbox, uid, reval.uidValidity);
        // Content is immutable per (uidValidity, uid): a stored body never
        // needs revalidation. Flags on the row were just revalidated above.
        if (msg && msg.bodyText !== undefined && msg.headers !== undefined) {
          store.touchAccess(account, mailbox, reval.uidValidity, [uid]);
          return toEmail(msg);
        }
      } catch {
        // A broken mirror must never break the tool — answer live.
      }
    }

    this.metrics.liveFallbacks += 1;
    const email = await this.imapService.getEmail(account, emailId, mailbox);
    this.persistBody(account, mailbox, uid, email);
    return email;
  }

  /** Best-effort write-back of a live-fetched body. Never throws. */
  private persistBody(account: string, mailbox: string, uid: number, email: Email): void {
    const store = this.store;
    if (!store) return;

    try {
      const state = store.getMailboxState(account, mailbox);
      if (!state) return;

      const isHtml = email.bodyText === undefined && email.bodyHtml !== undefined;
      const text = email.bodyText ?? email.bodyHtml;
      if (text === undefined || Buffer.byteLength(text, 'utf-8') > MAX_CACHED_BODY_BYTES) {
        // Nothing cacheable — record the attempt so backfill skips it too.
        store.markBodyAttempted(account, mailbox, uid, state.uidValidity);
        return;
      }

      const previewSource = isHtml ? stripHtml(text) : text;
      store.putBody(account, mailbox, uid, state.uidValidity, {
        text,
        subtype: isHtml ? 'html' : 'plain',
        headers: email.headers,
        preview: previewSource.replace(/\s+/g, ' ').trim().slice(0, 200),
      });
    } catch {
      // Cache failures never break the read path.
    }
  }

  // -------------------------------------------------------------------------
  // Pass-throughs (cached in later phases)
  // -------------------------------------------------------------------------

  searchEmails(
    account: string,
    query: string,
    options?: Parameters<ImapService['searchEmails']>[2],
  ): ReturnType<ImapService['searchEmails']> {
    return this.imapService.searchEmails(account, query, options);
  }

  getThread(
    account: string,
    messageId: string,
    mailbox?: string,
  ): ReturnType<ImapService['getThread']> {
    return this.imapService.getThread(account, messageId, mailbox);
  }

  findEmailFolder(
    account: string,
    emailId: string,
    sourceMailbox: string,
  ): ReturnType<ImapService['findEmailFolder']> {
    return this.imapService.findEmailFolder(account, emailId, sourceMailbox);
  }

  downloadAttachment(
    account: string,
    emailId: string,
    mailbox: string,
    filename: string,
    maxSizeBytes?: number,
  ): ReturnType<ImapService['downloadAttachment']> {
    return this.imapService.downloadAttachment(account, emailId, mailbox, filename, maxSizeBytes);
  }
}
