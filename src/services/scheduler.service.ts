/**
 * Scheduler service — JSON file-based email scheduling queue.
 *
 * Manages scheduled emails with a local file queue.
 * Source of truth is the JSON files in XDG state directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SCHEDULED_DIR, SCHEDULED_SENT_DIR } from '../config/xdg.js';
import { mcpLog } from '../logging.js';
import type { ScheduledEmail } from '../types/index.js';
import type ImapService from './imap.service.js';
import type SmtpService from './smtp.service.js';

/** Max age (ms) a claim may be held before a later runner reclaims it */
const STALE_LOCK_MS = 5 * 60 * 1000;

/** Max retry attempts before marking as "failed" */
const MAX_ATTEMPTS = 3;

/**
 * Suffix marking a queue entry as claimed. The claim is the rename itself —
 * only one caller can move a given path — so it doubles as the mutual
 * exclusion between the in-process interval and the OS scheduler daemon.
 */
const CLAIM_SUFFIX = '.claim';

/** Keep roughly a quarter of send history: "how far back can I look". */
const DEFAULT_SENT_RETENTION_DAYS = 90;

/** Floor between prunes within one long-lived process. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export default class SchedulerService {
  private readonly sentRetentionDays: number;

  private lastPrunedAt = 0;

  constructor(
    private smtpService: SmtpService,
    private imapService: ImapService,
    options: { sentRetentionDays?: number } = {},
  ) {
    this.sentRetentionDays = options.sentRetentionDays ?? DEFAULT_SENT_RETENTION_DAYS;
  }

  /**
   * Delete sent history past the retention window.
   *
   * Nothing used to remove anything from the sent directory, so it grew one
   * JSON file per sent email forever. Age-based rather than count-based: the
   * question a user asks is how far back they can look, never how many
   * entries to keep. A retention of 0 disables pruning.
   *
   * An entry is deleted only when its own `status` says `sent`. That is
   * redundant against the invariant that the directory holds nothing else,
   * which is the point: this is the third place in this subsystem where
   * trusting the directory over the field would destroy a live entry, and
   * here the cost is a scheduled email deleted before it is sent.
   */
  async pruneSent(): Promise<{ deleted: number; kept: number }> {
    if (this.sentRetentionDays <= 0) return { deleted: 0, kept: 0 };

    const cutoff = Date.now() - this.sentRetentionDays * 86_400_000;
    let deleted = 0;
    let kept = 0;

    let files: string[];
    try {
      files = await fs.readdir(SCHEDULED_SENT_DIR);
    } catch {
      return { deleted: 0, kept: 0 };
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const file of files) {
      if (!file.endsWith('.json')) continue; // eslint-disable-line no-continue
      const filePath = path.join(SCHEDULED_SENT_DIR, file);
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await fs.readFile(filePath, 'utf-8');
        const entry = JSON.parse(raw) as ScheduledEmail;
        // sentAt is written when delivery is recorded; createdAt is the
        // fallback for history written before that field existed.
        const stamp = Date.parse(entry.sentAt ?? entry.createdAt ?? '');
        if (entry.status !== 'sent' || !Number.isFinite(stamp) || stamp >= cutoff) {
          kept += 1;
          continue; // eslint-disable-line no-continue
        }
        // eslint-disable-next-line no-await-in-loop
        await fs.unlink(filePath);
        deleted += 1;
      } catch {
        // Unreadable or already gone — leave it alone rather than guess.
        kept += 1;
      }
    }

    this.lastPrunedAt = Date.now();
    return { deleted, kept };
  }

  /**
   * Prune at most once per PRUNE_INTERVAL_MS per process.
   *
   * A short-lived runner (the launchd/cron daemon the README recommends) gets
   * one prune per invocation, which is the "prune on startup" behaviour; a
   * long-lived server does not re-walk the history every minute.
   */
  private async pruneSentIfDue(): Promise<void> {
    if (Date.now() - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    try {
      await this.pruneSent();
    } catch {
      // Retention is housekeeping; never let it block a send.
      this.lastPrunedAt = Date.now();
    }
  }

  // -------------------------------------------------------------------------
  // Schedule a new email
  // -------------------------------------------------------------------------

  async schedule(
    account: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      sendAt: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      references?: string[];
    },
  ): Promise<ScheduledEmail> {
    const sendAtDate = new Date(options.sendAt);
    if (Number.isNaN(sendAtDate.getTime())) {
      throw new Error(`Invalid send_at date: ${options.sendAt}`);
    }
    if (sendAtDate.getTime() <= Date.now()) {
      throw new Error('send_at must be in the future');
    }

    const scheduled: ScheduledEmail = {
      id: crypto.randomUUID(),
      account,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      html: options.html ?? false,
      sendAt: sendAtDate.toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      inReplyTo: options.inReplyTo,
      references: options.references,
    };

    // Save IMAP draft (best-effort)
    try {
      const draftResult = await this.imapService.saveDraft(account, {
        to: options.to,
        subject: `[Scheduled: ${sendAtDate.toLocaleString()}] ${options.subject}`,
        body: options.body,
        cc: options.cc,
        html: options.html,
      });
      scheduled.draftMessageId = String(draftResult.id);
      scheduled.draftMailbox = draftResult.mailbox;
    } catch {
      // Draft mirror is best-effort
    }

    await SchedulerService.writeScheduledFile(scheduled);
    return scheduled;
  }

  // -------------------------------------------------------------------------
  // List scheduled emails
  // -------------------------------------------------------------------------

  // eslint-disable-next-line class-methods-use-this
  async list(
    options: { account?: string; status?: 'pending' | 'sent' | 'failed' | 'all' } = {},
  ): Promise<ScheduledEmail[]> {
    const status = options.status ?? 'pending';
    const emails: ScheduledEmail[] = [];

    // The status field decides what an entry is; the directory is only where
    // it currently lives. Those can disagree for an instant — a delivered
    // entry records its outcome before being moved — and skipping this
    // directory for a 'sent' query used to hide exactly that entry from both
    // the 'sent' and 'pending' listings, at the moment a user is most likely
    // to ask whether their mail went out.
    emails.push(...(await SchedulerService.readDir(SCHEDULED_DIR)));

    // The sent directory only ever receives entries already marked sent, so
    // it cannot satisfy a pending/failed query — and it is never pruned, so
    // reading it for those would mean walking the whole send history.
    if (status === 'sent' || status === 'all') {
      emails.push(...(await SchedulerService.readDir(SCHEDULED_SENT_DIR)));
    }

    // Filter by account if specified
    const filtered = options.account ? emails.filter((e) => e.account === options.account) : emails;

    // Filter by status unless "all"
    if (status !== 'all') {
      return filtered.filter((e) => e.status === status);
    }

    return filtered.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
  }

  // -------------------------------------------------------------------------
  // Cancel a scheduled email
  // -------------------------------------------------------------------------

  async cancel(scheduleId: string): Promise<{ cancelled: boolean; draftDeleted: boolean }> {
    const filePath = path.join(SCHEDULED_DIR, `${scheduleId}.json`);
    let draftDeleted = false;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const scheduled = JSON.parse(content) as ScheduledEmail;

      if (scheduled.status !== 'pending') {
        throw new Error(`Cannot cancel email with status "${scheduled.status}"`);
      }

      // Delete IMAP draft (best-effort)
      if (scheduled.draftMessageId && scheduled.draftMailbox) {
        try {
          await this.imapService.deleteEmail(
            scheduled.account,
            scheduled.draftMessageId,
            scheduled.draftMailbox,
          );
          draftDeleted = true;
        } catch {
          // Draft deletion is best-effort
        }
      }

      await fs.unlink(filePath);
      return { cancelled: true, draftDeleted };
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        // A claimed entry has been renamed out from under us, so say it is
        // going out rather than reporting it missing.
        const claimed = await fs
          .access(`${filePath}${CLAIM_SUFFIX}`)
          .then(() => true)
          .catch(() => false);
        if (claimed) {
          throw new Error(
            `Scheduled email "${scheduleId}" is already being sent and can no longer be cancelled`,
          );
        }
        throw new Error(`Scheduled email "${scheduleId}" not found`);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Check and send overdue emails
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop, no-continue -- Sequential file processing required */
  async checkAndSend(): Promise<{
    sent: number;
    failed: number;
    errors: string[];
  }> {
    const result = { sent: 0, failed: 0, errors: [] as string[] };
    await SchedulerService.ensureDirs();
    await this.pruneSentIfDue();

    let files: string[];
    try {
      files = await fs.readdir(SCHEDULED_DIR);
    } catch {
      return result;
    }

    const now = Date.now();

    // Recover claims abandoned by a crashed runner before looking for work.
    // Requeueing renames files, so re-read the directory to pick up anything
    // recovered in this same pass rather than leaving it until the next one.
    if (await this.recoverStaleClaims(files, now, result)) {
      files = await fs.readdir(SCHEDULED_DIR).catch(() => files);
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    // Process files sequentially — must not double-send
    // eslint-disable-next-line no-restricted-syntax
    for (const file of jsonFiles) {
      const filePath = path.join(SCHEDULED_DIR, file);
      let claimPath: string | undefined;

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const scheduled = JSON.parse(content) as ScheduledEmail;

        // Skip anything not waiting to go out. A 'sending' entry is either
        // held by a live runner or was just recovered above.
        if (scheduled.status !== 'pending') continue;

        // Skip if not yet due
        if (new Date(scheduled.sendAt).getTime() > now) continue;

        // Skip if max attempts exceeded
        if (scheduled.attempts >= MAX_ATTEMPTS) {
          scheduled.status = 'failed';
          scheduled.lastError = 'Max retry attempts exceeded';
          await SchedulerService.writeScheduledFile(scheduled);
          result.failed += 1;
          continue;
        }

        // Claim it. rename() is atomic and fails for everyone but the first
        // caller, which is what keeps the in-process interval and the
        // launchd/cron daemon from both sending the same message — the
        // previous read-then-write lock let both observe 'pending' first.
        claimPath = `${filePath}${CLAIM_SUFFIX}`;
        try {
          await fs.rename(filePath, claimPath);
        } catch {
          // Another runner got there first, or it was cancelled meanwhile.
          claimPath = undefined;
          continue;
        }

        // The claim is ours exclusively, so these writes need no further guard.
        scheduled.status = 'sending';
        scheduled.attempts += 1;
        scheduled.claimedAt = new Date().toISOString();
        delete scheduled.lastError;
        await SchedulerService.writeFileAt(claimPath, scheduled);

        // Record the handover to SMTP. After a crash this is the only
        // evidence that the message may already be on its way.
        scheduled.sendStartedAt = new Date().toISOString();
        await SchedulerService.writeFileAt(claimPath, scheduled);

        // Send
        const sendResult = await this.smtpService.sendEmail(scheduled.account, {
          to: scheduled.to,
          subject: scheduled.subject,
          body: scheduled.body,
          cc: scheduled.cc,
          bcc: scheduled.bcc,
          html: scheduled.html,
          // Persisted at schedule time; without them a scheduled reply is
          // delivered outside its thread.
          inReplyTo: scheduled.inReplyTo,
          references: scheduled.references,
        });

        // Record delivery on the claim itself, then move it. Writing the
        // outcome before the move means a crash in between leaves a claim
        // that proves the message went out, which recovery can resolve;
        // renaming rather than write-then-unlink means there is never an
        // instant where the entry exists in both directories at once.
        scheduled.status = 'sent';
        scheduled.sentAt = new Date().toISOString();
        scheduled.sentMessageId = sendResult.messageId;
        await SchedulerService.writeFileAt(claimPath, scheduled);

        const sentPath = path.join(SCHEDULED_SENT_DIR, file);
        await fs.rename(claimPath, sentPath);
        claimPath = undefined;

        // Delete draft (best-effort)
        if (scheduled.draftMessageId && scheduled.draftMailbox) {
          try {
            await this.imapService.deleteEmail(
              scheduled.account,
              scheduled.draftMessageId,
              scheduled.draftMailbox,
            );
          } catch {
            // Best-effort
          }
        }

        result.sent += 1;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${file}: ${errorMsg}`);

        // Record the failure and release the claim so a later pass can retry.
        try {
          const readFrom = claimPath ?? filePath;
          const content = await fs.readFile(readFrom, 'utf-8');
          const scheduled = JSON.parse(content) as ScheduledEmail;
          scheduled.status = scheduled.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
          scheduled.lastError = errorMsg;
          delete scheduled.claimedAt;
          delete scheduled.sendStartedAt;
          await fs.writeFile(readFrom, JSON.stringify(scheduled, null, 2));
          if (claimPath) await fs.rename(claimPath, filePath);
        } catch {
          // If we can't even update the file, leave the claim for stale
          // recovery rather than risking a second send now.
        }

        result.failed += 1;
      }
    }

    return result;
  }
  /* eslint-enable no-await-in-loop, no-continue */

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Return abandoned claims to the queue.
   *
   * A claim file outliving its runner means the process died mid-send, and how
   * far it got decides what is safe:
   *
   * - `sentMessageId` present — delivery was recorded before the move, so the
   *   message definitively went out and the interrupted move is finished.
   * - `sendStartedAt` only — the server was handed the message and its fate is
   *   unknown. Silently resending is how a user mails a client twice, so this
   *   fails with an explicit reason: recoverable by hand, never duplicated.
   * - neither — it never reached SMTP, so requeue it.
   *
   * @returns whether any claim was released, so the caller can re-read the dir
   */
  private async recoverStaleClaims(
    files: string[],
    now: number,
    result: { failed: number; errors: string[] },
  ): Promise<boolean> {
    const claims = files.filter((f) => f.endsWith(CLAIM_SUFFIX));
    let released = false;

    // eslint-disable-next-line no-restricted-syntax
    for (const claim of claims) {
      const claimPath = path.join(SCHEDULED_DIR, claim);
      const queuePath = claimPath.slice(0, -CLAIM_SUFFIX.length);

      try {
        // eslint-disable-next-line no-await-in-loop
        const content = await fs.readFile(claimPath, 'utf-8');
        const scheduled = JSON.parse(content) as ScheduledEmail;

        // Measure from the claim, not from createdAt: an email scheduled last
        // week is not a stale lock, and one claimed a second ago is not either.
        const heldSince = scheduled.claimedAt ?? scheduled.sendStartedAt;
        const age = heldSince ? now - new Date(heldSince).getTime() : Number.POSITIVE_INFINITY;
        if (age <= STALE_LOCK_MS) continue; // eslint-disable-line no-continue

        // Delivery was recorded before the move, so this one definitively
        // went out — finish the interrupted move instead of reporting a
        // delivered message as failed.
        if (scheduled.sentMessageId !== undefined || scheduled.status === 'sent') {
          // Normalize before the move so the sent directory keeps its
          // invariant of holding only sent entries — list() relies on it to
          // skip this directory for pending and failed queries.
          scheduled.status = 'sent';
          scheduled.sentAt ??= heldSince ?? new Date().toISOString();
          delete scheduled.claimedAt;
          const sentPath = path.join(SCHEDULED_SENT_DIR, path.basename(queuePath));
          // eslint-disable-next-line no-await-in-loop
          await fs.writeFile(claimPath, JSON.stringify(scheduled, null, 2));
          // eslint-disable-next-line no-await-in-loop
          await fs.rename(claimPath, sentPath);
          released = true;
          continue; // eslint-disable-line no-continue
        }

        if (scheduled.sendStartedAt) {
          scheduled.status = 'failed';
          scheduled.lastError =
            'Delivery status unknown — the runner stopped after handing the message to the ' +
            'server, so it may have been delivered. It was not resent automatically: check ' +
            'your Sent folder, or with the recipient, before rescheduling it.';
        } else {
          scheduled.status = 'pending';
        }
        delete scheduled.claimedAt;
        delete scheduled.sendStartedAt;

        // eslint-disable-next-line no-await-in-loop
        await fs.writeFile(claimPath, JSON.stringify(scheduled, null, 2));
        // eslint-disable-next-line no-await-in-loop
        await fs.rename(claimPath, queuePath);
        released = true;

        if (scheduled.status === 'failed') {
          result.failed += 1;
          result.errors.push(`${claim}: ${scheduled.lastError}`);
          // eslint-disable-next-line no-await-in-loop
          await mcpLog(
            'warning',
            'scheduler',
            `Scheduled email ${scheduled.id} was claimed and handed to SMTP but never completed — marked failed, not resent`,
          );
        }
      } catch {
        // Unreadable or already taken by another runner — leave it be.
      }
    }

    return released;
  }

  private static async ensureDirs(): Promise<void> {
    await fs.mkdir(SCHEDULED_DIR, { recursive: true });
    await fs.mkdir(SCHEDULED_SENT_DIR, { recursive: true });
  }

  private static async writeScheduledFile(scheduled: ScheduledEmail): Promise<void> {
    await SchedulerService.ensureDirs();
    const filePath = path.join(SCHEDULED_DIR, `${scheduled.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(scheduled, null, 2));
  }

  /** Write to an exact path — used for a claim file we already own. */
  private static async writeFileAt(filePath: string, scheduled: ScheduledEmail): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(scheduled, null, 2));
  }

  private static async readDir(dirPath: string): Promise<ScheduledEmail[]> {
    const emails: ScheduledEmail[] = [];
    try {
      const files = await fs.readdir(dirPath);
      // eslint-disable-next-line no-restricted-syntax
      for (const file of files) {
        // Claimed entries are mid-send, not gone — list_scheduled must still
        // show them or an email in flight looks like it vanished.
        if (!file.endsWith('.json') && !file.endsWith(CLAIM_SUFFIX)) continue; // eslint-disable-line no-continue
        try {
          const content = await fs.readFile(path.join(dirPath, file), 'utf-8'); // eslint-disable-line no-await-in-loop
          emails.push(JSON.parse(content) as ScheduledEmail);
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory may not exist yet
    }
    return emails;
  }
}
