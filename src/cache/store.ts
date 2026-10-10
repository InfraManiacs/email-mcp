/**
 * SQLite-backed local mirror of server-side mail.
 *
 * Uses `node:sqlite`, built into Node 24 — no native module, no install step,
 * nothing to rebuild across Node or architecture changes. The project already
 * requires Node >= 24, so this adds zero runtime dependencies.
 *
 * This class is deliberately dumb: it stores and retrieves rows and knows
 * nothing about IMAP. Reconciliation lives in the sync engine, and hit/stale/
 * offline policy lives in the MailReadService facade.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncTier = 'qresync' | 'condstore' | 'baseline';

export type BodySubtype = 'plain' | 'html';

/** A message as handed to the store for persistence. */
export interface CachedMessageInput {
  account: string;
  mailbox: string;
  uid: number;
  /** Cache epoch, as a decimal string — see schema.ts. */
  uidValidity: string;
  modseq?: string;
  /** RFC 8474 EMAILID / Gmail X-GM-MSGID: stable across moves. */
  emailId?: string;
  envelope: unknown;
  bodyStructure?: unknown;
  flags: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Epoch milliseconds. */
  internalDate: number;
  subject?: string;
  fromText?: string;
  preview?: string;
  hasAttachments: boolean;
  /** Attachment filenames, indexed for full-text search. */
  attachmentNames?: string[];
}

/** A message as read back out of the mirror. */
export interface CachedMessage {
  account: string;
  mailbox: string;
  uid: number;
  uidValidity: string;
  modseq?: string;
  emailId?: string;
  envelope: unknown;
  bodyStructure?: unknown;
  flags: string[];
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  internalDate: number;
  subject?: string;
  fromText?: string;
  preview?: string;
  bodyText?: string;
  bodySubtype?: BodySubtype;
  headers?: Record<string, string>;
  bodyFetchedAt?: number;
  hasAttachments: boolean;
  attachmentNames: string[];
  cachedAt: number;
  lastAccessedAt?: number;
}

/** A downloaded body attached to an existing message row. */
export interface CachedBodyInput {
  text: string;
  subtype?: BodySubtype;
  headers?: Record<string, string>;
  preview?: string;
}

export interface MailboxState {
  account: string;
  mailbox: string;
  uidValidity: string;
  uidNext?: number;
  highestModseq?: string;
  syncTier: SyncTier;
  totalMessages?: number;
  unseenMessages?: number;
  lastSyncedAt?: number;
  bodyBackfillUid?: number;
}

export interface PageOptions {
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * Filters for listMessages, mirroring the live IMAP listEmails filters so a
 * cached listing is substitutable for a live one.
 */
export interface MessageFilters {
  /** ISO date — messages at or after this instant. */
  since?: string;
  /** ISO date — messages strictly before this instant. */
  before?: string;
  /** Substring match against "Name <address>". */
  from?: string;
  /** Substring match against the subject. */
  subject?: string;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  hasAttachment?: boolean;
}

export interface MailboxCacheStats {
  account: string;
  mailbox: string;
  uidValidity: string;
  syncTier: SyncTier;
  totalMessages?: number;
  cachedMessages: number;
  bodiesCached: number;
  lastSyncedAt?: number;
}

export interface CacheStats {
  mailboxes: MailboxCacheStats[];
  messageCount: number;
  bodyCount: number;
  sizeBytes: number;
}

/** Raw row shape as returned by SQLite. */
interface MailboxStateRow {
  account: string;
  mailbox: string;
  uid_validity: string;
  uid_next: number | null;
  highest_modseq: string | null;
  sync_tier: string;
  total_messages: number | null;
  unseen_messages: number | null;
  last_synced_at: number | null;
  body_backfill_uid: number | null;
}

interface MessageRow {
  account: string;
  mailbox: string;
  uid: number;
  uid_validity: string;
  modseq: string | null;
  email_id: string | null;
  envelope_json: string;
  body_structure_json: string | null;
  flags_json: string;
  seen: number;
  flagged: number;
  answered: number;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  internal_date: number;
  subject: string | null;
  from_text: string | null;
  preview: string | null;
  body_text: string | null;
  body_subtype: string | null;
  headers_json: string | null;
  body_fetched_at: number | null;
  has_attachments: number;
  attachment_names: string | null;
  cached_at: number;
  last_accessed_at: number | null;
}

function rowToMessage(row: MessageRow): CachedMessage {
  return {
    account: row.account,
    mailbox: row.mailbox,
    uid: row.uid,
    uidValidity: row.uid_validity,
    modseq: row.modseq ?? undefined,
    emailId: row.email_id ?? undefined,
    envelope: JSON.parse(row.envelope_json),
    bodyStructure: row.body_structure_json ? JSON.parse(row.body_structure_json) : undefined,
    flags: JSON.parse(row.flags_json),
    seen: row.seen === 1,
    flagged: row.flagged === 1,
    answered: row.answered === 1,
    messageId: row.message_id ?? undefined,
    inReplyTo: row.in_reply_to ?? undefined,
    references: row.references_json ? JSON.parse(row.references_json) : undefined,
    internalDate: row.internal_date,
    subject: row.subject ?? undefined,
    fromText: row.from_text ?? undefined,
    preview: row.preview ?? undefined,
    bodyText: row.body_text ?? undefined,
    bodySubtype: (row.body_subtype as BodySubtype | null) ?? undefined,
    headers: row.headers_json ? JSON.parse(row.headers_json) : undefined,
    bodyFetchedAt: row.body_fetched_at ?? undefined,
    hasAttachments: row.has_attachments === 1,
    attachmentNames: row.attachment_names ? row.attachment_names.split('\n') : [],
    cachedAt: row.cached_at,
    lastAccessedAt: row.last_accessed_at ?? undefined,
  };
}

/**
 * Escape a user query for FTS5 MATCH.
 *
 * FTS5 has its own query syntax where bare `-`, `*`, `"` and `:` are
 * operators. Users type mail search terms, not FTS5 expressions, so each token
 * is quoted and treated literally rather than risking a syntax error on a
 * subject line like "Re: Q3 -- draft".
 */
function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(' ');
}

/** Escape %, _ and \ so user text is a literal in a LIKE pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function flagColumns(flags: string[]): { seen: number; flagged: number; answered: number } {
  return {
    seen: flags.includes('\\Seen') ? 1 : 0,
    flagged: flags.includes('\\Flagged') ? 1 : 0,
    answered: flags.includes('\\Answered') ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export default class CacheStore {
  private db: DatabaseSync;

  private readonly dbPath: string;

  /**
   * Prepared statements, keyed by SQL. `node:sqlite` has no built-in
   * statement cache, and re-preparing on every call costs more than the
   * query itself for point reads.
   */
  private stmts = new Map<string, StatementSync>();

  /**
   * @param dbPath filesystem path, or ':memory:' for tests.
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = this.open();
    this.migrate();

    if (dbPath !== ':memory:') {
      fs.chmodSync(dbPath, 0o600);
    }
  }

  /** Open the database and apply the per-connection pragmas. */
  private open(): DatabaseSync {
    if (this.dbPath !== ':memory:') {
      // 0700: the mirror holds message bodies, so it is owner-only. This plus
      // full-disk encryption is the documented at-rest posture.
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    }

    // `timeout` sets busy_timeout, so concurrent readers wait rather than
    // failing immediately with SQLITE_BUSY.
    const db = new DatabaseSync(this.dbPath, { timeout: 5000 });

    // auto_vacuum must be set before the first table is created to take
    // effect — this is why migrate() recreates the file rather than dropping
    // tables. INCREMENTAL lets the eviction loop hand pages back with
    // `PRAGMA incremental_vacuum` instead of a full VACUUM rewrite.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');

    // WAL lets readers proceed during a write — important because sync runs in
    // the background while tool calls read. NORMAL trades an fsync per commit
    // for a small crash window, which is the right call for regenerable data.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA temp_store = MEMORY');
    // Keep the WAL from growing unbounded between the idle TRUNCATE
    // checkpoints maintenance runs after sync bursts.
    db.exec('PRAGMA wal_autocheckpoint = 1000');

    return db;
  }

  /**
   * Apply the schema, rebuilding from scratch if the file was written by any
   * other build (older or newer — CREATE IF NOT EXISTS cannot reshape an
   * existing table). The mirror is regenerable, so discarding it is always
   * safe and is preferable to failing at startup. Rebuilding recreates the
   * file rather than dropping tables: auto_vacuum only applies to a database
   * whose tables were created after the pragma was set.
   */
  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };

    if (version !== SCHEMA_VERSION) {
      if (this.dbPath === ':memory:') {
        this.db.exec('DROP TABLE IF EXISTS message_fts');
        this.db.exec('DROP TABLE IF EXISTS message');
        this.db.exec('DROP TABLE IF EXISTS mailbox_state');
        this.db.exec('DROP TABLE IF EXISTS attachment');
      } else {
        this.db.close();
        this.stmts.clear();
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(`${this.dbPath}${suffix}`, { force: true });
        }
        this.db = this.open();
      }
    }

    this.db.exec(SCHEMA_SQL);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Run `fn` inside an immediate transaction.
   *
   * BEGIN IMMEDIATE rather than the default deferred: busy_timeout does not
   * apply when a read transaction tries to upgrade to a write, which is the
   * usual source of spurious SQLITE_BUSY errors.
   */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private prep(sql: string): StatementSync {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Query helpers.
   *
   * `node:sqlite` types rows as `Record<string, SQLOutputValue>`, which never
   * structurally overlaps a concrete row interface. The cast is unavoidable;
   * confining it to these two helpers keeps it from spreading across every
   * query, and the row interfaces stay the single description of table shape.
   */
  private queryAll<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.prep(sql).all(...params) as unknown as T[];
  }

  private queryOne<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.prep(sql).get(...params) as unknown as T | undefined;
  }

  close(): void {
    // Refresh the query planner's statistics while we know the data shape;
    // sqlite recommends this on connection close.
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      // Closing is best-effort; never mask the caller's shutdown path.
    }
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Insert or update messages.
   *
   * Already-downloaded content is preserved: a metadata resync (a flag
   * change, say) must not discard a body, headers or preview and force a
   * second download. COALESCE keeps the stored value when the incoming row
   * has none.
   */
  putMessages(messages: CachedMessageInput[]): void {
    if (messages.length === 0) return;

    const stmt = this.prep(`
      INSERT INTO message (
        account, mailbox, uid, uid_validity, modseq, email_id,
        envelope_json, body_structure_json, flags_json,
        seen, flagged, answered,
        message_id, in_reply_to, references_json,
        internal_date, subject, from_text, preview,
        has_attachments, attachment_names, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account, mailbox, uid, uid_validity) DO UPDATE SET
        modseq              = excluded.modseq,
        email_id            = COALESCE(excluded.email_id, message.email_id),
        envelope_json       = excluded.envelope_json,
        body_structure_json = excluded.body_structure_json,
        flags_json          = excluded.flags_json,
        seen                = excluded.seen,
        flagged             = excluded.flagged,
        answered            = excluded.answered,
        message_id          = excluded.message_id,
        in_reply_to         = excluded.in_reply_to,
        references_json     = COALESCE(excluded.references_json, message.references_json),
        internal_date       = excluded.internal_date,
        subject             = excluded.subject,
        from_text           = excluded.from_text,
        preview             = COALESCE(excluded.preview, message.preview),
        has_attachments     = excluded.has_attachments,
        attachment_names    = excluded.attachment_names,
        cached_at           = excluded.cached_at
    `);

    const now = Date.now();
    this.transaction(() => {
      messages.forEach((m) => {
        const flags = flagColumns(m.flags);
        stmt.run(
          m.account,
          m.mailbox,
          m.uid,
          m.uidValidity,
          m.modseq ?? null,
          m.emailId ?? null,
          JSON.stringify(m.envelope),
          m.bodyStructure ? JSON.stringify(m.bodyStructure) : null,
          JSON.stringify(m.flags),
          flags.seen,
          flags.flagged,
          flags.answered,
          m.messageId ?? null,
          m.inReplyTo ?? null,
          m.references ? JSON.stringify(m.references) : null,
          m.internalDate,
          m.subject ?? null,
          m.fromText ?? null,
          m.preview ?? null,
          m.hasAttachments ? 1 : 0,
          m.attachmentNames?.length ? m.attachmentNames.join('\n') : null,
          now,
        );
      });
    });
  }

  /** Attach a downloaded body (and its immutable metadata) to a message. */
  putBody(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
    body: CachedBodyInput,
  ): void {
    this.prep(`
      UPDATE message SET
        body_text       = ?,
        body_subtype    = ?,
        headers_json    = COALESCE(?, headers_json),
        preview         = COALESCE(?, preview),
        body_fetched_at = ?
      WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
    `).run(
      body.text,
      body.subtype ?? 'plain',
      body.headers ? JSON.stringify(body.headers) : null,
      body.preview ?? null,
      Date.now(),
      account,
      mailbox,
      uid,
      uidValidity,
    );
  }

  /**
   * Update a message's flags (and the derived filter columns) in place.
   *
   * Used by write-through invalidation: a flag change acknowledged by the
   * server is reflected immediately instead of waiting for the next sync.
   */
  applyFlags(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
    flags: string[],
  ): void {
    const cols = flagColumns(flags);
    this.prep(`
      UPDATE message SET flags_json = ?, seen = ?, flagged = ?, answered = ?
      WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
    `).run(
      JSON.stringify(flags),
      cols.seen,
      cols.flagged,
      cols.answered,
      account,
      mailbox,
      uid,
      uidValidity,
    );
  }

  /** Record a read access, so eviction can rank by recency. */
  touchAccess(account: string, mailbox: string, uidValidity: string, uids: number[]): void {
    if (uids.length === 0) return;

    const stmt = this.prep(`
      UPDATE message SET last_accessed_at = ?
      WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
    `);
    const now = Date.now();
    this.transaction(() => {
      uids.forEach((uid) => {
        stmt.run(now, account, mailbox, uid, uidValidity);
      });
    });
  }

  getMessage(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
  ): CachedMessage | undefined {
    const row = this.queryOne<MessageRow>(
      `SELECT * FROM message
       WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?`,
      account,
      mailbox,
      uid,
      uidValidity,
    );

    return row ? rowToMessage(row) : undefined;
  }

  /** Look a message up by Message-ID across every mailbox of an account. */
  findByMessageId(account: string, messageId: string): CachedMessage[] {
    return this.queryAll<MessageRow>(
      'SELECT * FROM message WHERE account = ? AND message_id = ?',
      account,
      messageId,
    ).map(rowToMessage);
  }

  /** Newest-first page. Costs the same at page 50 as at page 1. */
  listMessages(
    account: string,
    mailbox: string,
    uidValidity: string,
    options: PageOptions,
    filters: MessageFilters = {},
  ): Page<CachedMessage> {
    const { page, pageSize } = options;
    const offset = (page - 1) * pageSize;

    const where: string[] = ['account = ?', 'mailbox = ?', 'uid_validity = ?'];
    const params: (string | number)[] = [account, mailbox, uidValidity];

    if (filters.since !== undefined) {
      where.push('internal_date >= ?');
      params.push(Date.parse(filters.since));
    }
    if (filters.before !== undefined) {
      where.push('internal_date < ?');
      params.push(Date.parse(filters.before));
    }
    if (filters.from !== undefined) {
      where.push("from_text LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(filters.from)}%`);
    }
    if (filters.subject !== undefined) {
      where.push("subject LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(filters.subject)}%`);
    }
    if (filters.seen !== undefined) {
      where.push('seen = ?');
      params.push(filters.seen ? 1 : 0);
    }
    if (filters.flagged !== undefined) {
      where.push('flagged = ?');
      params.push(filters.flagged ? 1 : 0);
    }
    if (filters.answered !== undefined) {
      where.push('answered = ?');
      params.push(filters.answered ? 1 : 0);
    }
    if (filters.hasAttachment !== undefined) {
      where.push('has_attachments = ?');
      params.push(filters.hasAttachment ? 1 : 0);
    }

    const whereSql = where.join(' AND ');

    const total =
      this.queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM message WHERE ${whereSql}`,
        ...params,
      )?.total ?? 0;

    const rows = this.queryAll<MessageRow>(
      `SELECT * FROM message
       WHERE ${whereSql}
       ORDER BY internal_date DESC
       LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      offset,
    );

    return {
      items: rows.map(rowToMessage),
      total,
      page,
      pageSize,
      hasMore: offset + rows.length < total,
    };
  }

  /** Full-text search over subject, sender, body and attachment names. */
  searchMessages(
    account: string,
    mailbox: string,
    uidValidity: string,
    query: string,
    limit = 100,
  ): CachedMessage[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery.length === 0) return [];

    return this.queryAll<MessageRow>(
      `SELECT m.* FROM message_fts f
       JOIN message m ON m.rowid = f.rowid
       WHERE message_fts MATCH ?
         AND m.account = ? AND m.mailbox = ? AND m.uid_validity = ?
       ORDER BY bm25(message_fts)
       LIMIT ?`,
      ftsQuery,
      account,
      mailbox,
      uidValidity,
      limit,
    ).map(rowToMessage);
  }

  /**
   * Every cached UID for one mailbox generation.
   *
   * Used by the sync engine to diff against the server's UID set, which on a
   * server without QRESYNC is the only way a deletion is ever detected.
   */
  listAllUids(account: string, mailbox: string, uidValidity: string): number[] {
    return this.queryAll<{ uid: number }>(
      `SELECT uid FROM message
       WHERE account = ? AND mailbox = ? AND uid_validity = ?`,
      account,
      mailbox,
      uidValidity,
    ).map((r) => r.uid);
  }

  /** UIDs of cached messages that still lack a body, newest first. */
  listMissingBodies(
    account: string,
    mailbox: string,
    uidValidity: string,
    limit: number,
  ): number[] {
    return this.queryAll<{ uid: number }>(
      `SELECT uid FROM message
       WHERE account = ? AND mailbox = ? AND uid_validity = ? AND body_text IS NULL
       ORDER BY internal_date DESC, uid DESC
       LIMIT ?`,
      account,
      mailbox,
      uidValidity,
      limit,
    ).map((r) => r.uid);
  }

  countMessages(account: string, mailbox: string): number {
    return (
      this.queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM message WHERE account = ? AND mailbox = ?',
        account,
        mailbox,
      )?.total ?? 0
    );
  }

  deleteMessages(account: string, mailbox: string, uids: number[], uidValidity: string): void {
    if (uids.length === 0) return;

    const stmt = this.prep(`
      DELETE FROM message
      WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
    `);

    this.transaction(() => {
      uids.forEach((uid) => {
        stmt.run(account, mailbox, uid, uidValidity);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Mailbox state
  // -------------------------------------------------------------------------

  putMailboxState(state: MailboxState): void {
    this.prep(`
      INSERT INTO mailbox_state (
        account, mailbox, uid_validity, uid_next, highest_modseq,
        sync_tier, total_messages, unseen_messages, last_synced_at,
        body_backfill_uid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account, mailbox) DO UPDATE SET
        uid_validity      = excluded.uid_validity,
        uid_next          = excluded.uid_next,
        highest_modseq    = excluded.highest_modseq,
        sync_tier         = excluded.sync_tier,
        total_messages    = excluded.total_messages,
        unseen_messages   = excluded.unseen_messages,
        last_synced_at    = excluded.last_synced_at,
        body_backfill_uid = COALESCE(excluded.body_backfill_uid, mailbox_state.body_backfill_uid)
    `).run(
      state.account,
      state.mailbox,
      state.uidValidity,
      state.uidNext ?? null,
      state.highestModseq ?? null,
      state.syncTier,
      state.totalMessages ?? null,
      state.unseenMessages ?? null,
      state.lastSyncedAt ?? Date.now(),
      state.bodyBackfillUid ?? null,
    );
  }

  getMailboxState(account: string, mailbox: string): MailboxState | undefined {
    const row = this.queryOne<MailboxStateRow>(
      'SELECT * FROM mailbox_state WHERE account = ? AND mailbox = ?',
      account,
      mailbox,
    );

    if (!row) return undefined;

    return {
      account: row.account,
      mailbox: row.mailbox,
      uidValidity: row.uid_validity,
      uidNext: row.uid_next ?? undefined,
      highestModseq: row.highest_modseq ?? undefined,
      syncTier: row.sync_tier as SyncTier,
      totalMessages: row.total_messages ?? undefined,
      unseenMessages: row.unseen_messages ?? undefined,
      lastSyncedAt: row.last_synced_at ?? undefined,
      bodyBackfillUid: row.body_backfill_uid ?? undefined,
    };
  }

  /**
   * Start a new cache epoch for a mailbox.
   *
   * Called when the server reports a UIDVALIDITY different from the stored
   * one: every cached UID for that mailbox now refers to a different message,
   * so the generation is dropped wholesale.
   *
   * @returns how many messages were discarded.
   */
  resetEpoch(account: string, mailbox: string, newUidValidity: string): number {
    return this.transaction(() => {
      const { changes } = this.prep(`
        DELETE FROM message
        WHERE account = ? AND mailbox = ? AND uid_validity <> ?
      `).run(account, mailbox, newUidValidity);

      this.prep(`
        DELETE FROM attachment
        WHERE account = ? AND mailbox = ? AND uid_validity <> ?
      `).run(account, mailbox, newUidValidity);

      this.prep(`
        INSERT INTO mailbox_state (account, mailbox, uid_validity, sync_tier)
        VALUES (?, ?, ?, 'baseline')
        ON CONFLICT (account, mailbox) DO UPDATE SET
          uid_validity      = excluded.uid_validity,
          uid_next          = NULL,
          highest_modseq    = NULL,
          body_backfill_uid = NULL
      `).run(account, mailbox, newUidValidity);

      return Number(changes);
    });
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Drop mirrored mail. Never touches the outbox, which is a separate file. */
  clear(account?: string): void {
    this.transaction(() => {
      if (account) {
        this.prep('DELETE FROM message WHERE account = ?').run(account);
        this.prep('DELETE FROM attachment WHERE account = ?').run(account);
        this.prep('DELETE FROM mailbox_state WHERE account = ?').run(account);
      } else {
        this.db.exec('DELETE FROM message');
        this.db.exec('DELETE FROM attachment');
        this.db.exec('DELETE FROM mailbox_state');
      }
    });
  }

  /** On-disk size in bytes, for `cache status`. */
  sizeBytes(): number {
    return (
      this.queryOne<{ size: number }>(
        'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
      )?.size ?? 0
    );
  }

  /** Per-mailbox mirror statistics, for `cache status` and check_health. */
  getStats(): CacheStats {
    const mailboxes = this.queryAll<{
      account: string;
      mailbox: string;
      uid_validity: string;
      sync_tier: string;
      total_messages: number | null;
      last_synced_at: number | null;
      cached_messages: number;
      bodies_cached: number;
    }>(
      `SELECT
         ms.account, ms.mailbox, ms.uid_validity, ms.sync_tier,
         ms.total_messages, ms.last_synced_at,
         (SELECT COUNT(*) FROM message m
           WHERE m.account = ms.account AND m.mailbox = ms.mailbox
             AND m.uid_validity = ms.uid_validity)                        AS cached_messages,
         (SELECT COUNT(*) FROM message m
           WHERE m.account = ms.account AND m.mailbox = ms.mailbox
             AND m.uid_validity = ms.uid_validity
             AND m.body_text IS NOT NULL)                                 AS bodies_cached
       FROM mailbox_state ms
       ORDER BY ms.account, ms.mailbox`,
    ).map((row) => ({
      account: row.account,
      mailbox: row.mailbox,
      uidValidity: row.uid_validity,
      syncTier: row.sync_tier as SyncTier,
      totalMessages: row.total_messages ?? undefined,
      cachedMessages: row.cached_messages,
      bodiesCached: row.bodies_cached,
      lastSyncedAt: row.last_synced_at ?? undefined,
    }));

    const messageCount =
      this.queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM message')?.total ?? 0;
    const bodyCount =
      this.queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM message WHERE body_text IS NOT NULL',
      )?.total ?? 0;

    return { mailboxes, messageCount, bodyCount, sizeBytes: this.sizeBytes() };
  }

  /** Truncate the WAL after a sync burst; cheap when there is nothing to do. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Hand freed pages back to the filesystem.
   *
   * @param pages maximum pages to free; omit to free all currently on the
   *   freelist.
   */
  incrementalVacuum(pages?: number): void {
    this.db.exec(
      pages === undefined ? 'PRAGMA incremental_vacuum' : `PRAGMA incremental_vacuum(${pages})`,
    );
  }
}
