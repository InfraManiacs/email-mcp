/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import { sanitizeTemplateVariable } from '../safety/validation.js';
import type { SendResult } from '../types/index.js';
import { stripHtml } from '../utils/html.js';
import type { PreparedAttachment } from './attachments.js';
import type ImapService from './imap.service.js';

/** Per-file ceiling when re-fetching originals for a forward. */
const FORWARD_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Narrow a prepared attachment to what nodemailer needs. A cid moves the file
 * into multipart/related beside the HTML part, so it must ship as inline —
 * as a classic attachment it would show up as a stray file instead of
 * rendering where the <img src="cid:..."> points.
 */
function toTransportAttachment({ filename, path, cid, contentType }: PreparedAttachment): {
  filename: string;
  path: string;
  cid?: string;
  contentDisposition?: 'inline';
  contentType?: string;
} {
  return {
    filename,
    path,
    ...(cid ? { cid, contentDisposition: 'inline' as const } : {}),
    ...(contentType ? { contentType } : {}),
  };
}

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      attachments?: PreparedAttachment[];
      /** Threading headers — a scheduled reply keeps its place in the thread. */
      inReplyTo?: string;
      references?: string[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
      ...(options.references?.length ? { references: options.references.join(' ') } : {}),
      // nodemailer 10 removed text:'auto' — generate the plain alternative
      // here so HTML mail goes out as multipart/alternative, not single-part.
      ...(options.html
        ? { html: options.body, text: stripHtml(options.body) }
        : { text: options.body }),
      ...(options.attachments?.length
        ? { attachments: options.attachments.map(toTransportAttachment) }
        : {}),
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
      attachments?: PreparedAttachment[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list
    const to = [original.from.address];
    const cc: string[] = [];

    if (options.replyAll) {
      // Add all original To recipients except ourselves
      original.to
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          to.push(addr.address);
        });
      // Add CC recipients except ourselves
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html
        ? { html: options.body, text: stripHtml(options.body) }
        : { text: options.body }),
      ...(options.attachments?.length
        ? { attachments: options.attachments.map(toTransportAttachment) }
        : {}),
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
      includeAttachments?: boolean;
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Carry the original's attachments unless explicitly declined -- a forward
    // that silently strips them misrepresents the original message. Inline
    // parts (cid images referenced by the HTML) stay behind: the forward is
    // composed as text, so re-attaching them would turn layout images into
    // stray attachments.
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    const forwardable = (original.attachments ?? []).filter((a) => !a.inline);
    if (options.includeAttachments !== false && forwardable.length) {
      for (const meta of forwardable) {
        const dl = await this.imapService.downloadAttachment(
          accountName,
          options.emailId,
          options.mailbox ?? 'INBOX',
          meta.partId !== undefined ? { partId: meta.partId } : meta.filename,
          FORWARD_ATTACHMENT_MAX_BYTES,
        );
        attachments.push({
          filename: dl.filename,
          content: Buffer.from(dl.contentBase64, 'base64'),
          contentType: dl.mimeType,
        });
      }
    }

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

    // Build forwarded message body
    const forwardHeader = [
      '',
      '---------- Forwarded message ----------',
      `From: ${original.from.name ? `${original.from.name} <${original.from.address}>` : original.from.address}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to.map((a) => a.address).join(', ')}`,
      '',
    ].join('\n');

    // The common case is an HTML-only original — raw markup in a text/plain
    // part is unreadable, so the original is converted and "> "-quoted. The
    // forward header stays unquoted: it is this message's text, not theirs.
    const originalText =
      original.bodyText ?? (original.bodyHtml ? stripHtml(original.bodyHtml) : '');
    const quotedOriginal = originalText
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n');
    const textBody = (options.body ?? '') + forwardHeader + quotedOriginal;

    let htmlBody: string | undefined;
    if (options.html) {
      const esc = (s: string) => sanitizeTemplateVariable(s, true);
      const note = options.body ? `<p>${esc(options.body).replace(/\n/g, '<br>')}</p>` : '';
      const headerHtml = forwardHeader.trim().split('\n').map(esc).join('<br>');
      const originalHtml =
        original.bodyHtml ?? (originalText ? `<pre>${esc(originalText)}</pre>` : '');
      htmlBody =
        `${note}<div>${headerHtml}</div>` +
        `<blockquote style="border-left:2px solid #ccc;margin:0 0 0 8px;padding-left:8px">${originalHtml}</blockquote>`;
    }

    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: textBody,
      ...(htmlBody ? { html: htmlBody } : {}),
      ...(attachments.length ? { attachments } : {}),
    });

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');

    const result = await transport.sendMail({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml
        ? { html: draft.bodyHtml, text: draft.bodyText ?? stripHtml(draft.bodyHtml) }
        : { text: draft.bodyText ?? '' }),
    });

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }
}
