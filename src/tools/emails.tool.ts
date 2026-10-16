/**
 * MCP tools: list_emails, get_email, get_emails, get_email_status, search_emails
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { describeAttachments } from '../services/attachments.js';
import type ImapService from '../services/imap.service.js';
import type MailReadService from '../services/mail-read.service.js';
import type { Email, EmailMeta } from '../types/index.js';
import {
  applyBodyFormat,
  type BodyFormat,
  DEFAULT_MULTI_BODY_MAX,
  DEFAULT_SINGLE_BODY_MAX,
} from '../utils/body-format.js';
import { formatBulk } from '../utils/bulk-headers.js';
import { emailListOutputSchema, emailStatusOutputSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatEmailMeta(email: EmailMeta): string {
  const flags = [
    email.seen ? '' : '🔵',
    email.flagged ? '⭐' : '',
    email.answered ? '↩️' : '',
    email.hasAttachments ? '📎' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const from = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const labelStr = email.labels.length > 0 ? `\n  🏷️ ${email.labels.join(', ')}` : '';
  const bulk = formatBulk(email.bulk);
  const bulkStr = bulk ? `\n  ${bulk}` : '';

  return `[${email.id}] ${flags} ${email.subject}\n  From: ${from} | ${email.date}${labelStr}${bulkStr}${email.preview ? `\n  ${email.preview}` : ''}`;
}

/** Renders the current read/flag/label state as a concise status line. */
function formatEmailStatus(email: Pick<Email, 'seen' | 'flagged' | 'answered' | 'labels'>): string {
  const parts: string[] = [email.seen ? '✓ Read' : '🔵 Unread'];
  if (email.flagged) parts.push('⭐ Flagged');
  if (email.answered) parts.push('↩️ Replied');
  const labelStr = email.labels.length > 0 ? ` · 🏷️ ${email.labels.join(', ')}` : '';
  return `${parts.join(' · ')}${labelStr}`;
}

// ---------------------------------------------------------------------------

export default function registerEmailsTools(
  server: McpServer,
  mailReadService: MailReadService,
  imapService: ImapService,
): void {
  // ---------------------------------------------------------------------------
  // list_emails
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_emails',
    {
      title: 'List emails',
      description:
        'List emails in a mailbox with optional filters. Returns paginated results with metadata ' +
        '(read/unread 🔵, flagged ⭐, replied ↩️, attachments 📎, labels 🏷️). ' +
        'List or machine-generated mail is marked 📰 newsletter / 🤖 automated from its RFC headers, ' +
        'with the unsubscribe URI when the sender offers one — personal mail carries no marker. ' +
        'Use get_email to fetch full body content. ' +
        'ProtonMail note: labels are represented as IMAP folders — use list_labels to discover them, ' +
        'then list_emails with mailbox="Labels/X" to find labeled emails.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
        page: z.coerce.number().int().min(1).default(1).describe('Page number'),
        pageSize: z.coerce.number().int().min(1).max(100).default(20).describe('Results per page'),
        since: z.string().optional().describe('Show emails after this date (ISO 8601)'),
        before: z.string().optional().describe('Show emails before this date (ISO 8601)'),
        from: z.string().optional().describe('Filter by sender address or name'),
        subject: z.string().optional().describe('Filter by subject keyword'),
        seen: z.boolean().optional().describe('Filter: true=read only, false=unread only'),
        flagged: z.boolean().optional().describe('Filter: true=flagged only, false=unflagged only'),
        has_attachment: z
          .boolean()
          .optional()
          .describe('Filter: true=has attachments, false=no attachments'),
        answered: z.boolean().optional().describe('Filter: true=replied, false=not yet replied'),
        preview: z
          .boolean()
          .default(false)
          .describe(
            'Include a ~200 character body preview per message. Off by default: it fetches extra bytes per message and lengthens the output.',
          ),
      }),
      outputSchema: emailListOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params) => {
      try {
        const result = await mailReadService.listEmails(params.account, {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          since: params.since,
          before: params.before,
          from: params.from,
          subject: params.subject,
          seen: params.seen,
          flagged: params.flagged,
          hasAttachment: params.has_attachment,
          answered: params.answered,
          preview: params.preview,
        });

        if (result.items.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No emails found matching the criteria.' }],
            structuredContent: {
              account: params.account,
              mailbox: params.mailbox,
              total: 0,
              page: params.page,
              pageSize: params.pageSize,
              hasMore: false,
              count: 0,
              emails: [],
            },
          };
        }

        const header =
          `📬 [${params.mailbox}] ${result.total} emails ` +
          `(page ${result.page}/${Math.ceil(result.total / result.pageSize)})` +
          `${result.hasMore ? ' — more pages available' : ''}\n`;
        const emails = result.items.map(formatEmailMeta).join('\n\n');

        return {
          content: [{ type: 'text' as const, text: `${header}\n${emails}` }],
          structuredContent: {
            account: params.account,
            mailbox: params.mailbox,
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            hasMore: result.hasMore,
            count: result.items.length,
            emails: result.items,
            ...(result.cache ? { cache: result.cache } : {}),
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_email',
    {
      title: 'Get email',
      description:
        'Get the full content of a specific email by ID. ' +
        'Does NOT mark the email as seen (uses IMAP BODY.PEEK — non-destructive). ' +
        'format: text (default) = HTML converted to readable text with [markdown](links); ' +
        'stripped = text minus quoted replies and signatures; full = raw body part (HTML mail returns raw HTML). ' +
        `Body is capped at ${DEFAULT_SINGLE_BODY_MAX} chars by default — pass maxLength (0 = unlimited) to change. ` +
        'Set markRead=true only when you want to explicitly mark the email as read. ' +
        'A Bulk: line appears for list or machine-generated mail (📰 newsletter / 🤖 automated), ' +
        'derived from RFC headers, with the unsubscribe URI when the sender offers one.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID from list_emails or search_emails'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
        format: z
          .enum(['full', 'text', 'stripped'])
          .default('text')
          .describe(
            'Body format: text=readable text with markdown links (default), stripped=text without quoted replies or signatures, full=raw body part',
          ),
        maxLength: z.coerce
          .number()
          .int()
          .min(0)
          .default(DEFAULT_SINGLE_BODY_MAX)
          .describe(
            `Truncate body at this many characters (default ${DEFAULT_SINGLE_BODY_MAX}; 0 = unlimited). A hint shows how many characters remain.`,
          ),
        markRead: z
          .boolean()
          .default(false)
          .describe(
            'Explicitly mark the email as read after fetching (default: false — reading is non-destructive by default)',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, emailId, mailbox, format, maxLength, markRead }) => {
      try {
        const email = await mailReadService.getEmail(account, emailId, mailbox);

        const parts: string[] = [
          `📧 ${email.subject}`,
          `Status: ${formatEmailStatus(email)}`,
          `From:   ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
          `To:     ${email.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`,
        ];

        if (email.cc?.length) {
          parts.push(`CC:     ${email.cc.map((a) => a.address).join(', ')}`);
        }

        parts.push(`Date:   ${email.date}`);
        // Labelled in full because this output also carries the UID used as
        // `emailId`; "ID" alone leaves the caller guessing which identifier
        // get_thread's `message_id` wants.
        parts.push(`Message-ID: ${email.messageId}`);

        const bulk = formatBulk(email.bulk);
        if (bulk) {
          parts.push(`Bulk:   ${bulk}`);
        }

        if (email.inReplyTo) {
          parts.push(`Reply:  ${email.inReplyTo}`);
        }

        if (email.attachments.length > 0) {
          // Includes each part id, which is what download_attachment needs and
          // the only way to address an unnamed inline cid image.
          parts.push(`📎 Attachments: ${describeAttachments(email.attachments)}`);
        }

        if (email.deliveryStatus) {
          // A bounce reads like an ordinary email without this — the codes
          // that say what actually failed live in a non-text MIME part.
          parts.push('', '⚠️ Delivery status:', email.deliveryStatus);
        }

        parts.push('', '--- Body ---', '');
        parts.push(
          applyBodyFormat(email.bodyText, email.bodyHtml, format as BodyFormat, maxLength),
        );

        if (markRead) {
          await imapService.setFlags(account, emailId, mailbox, 'read');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_emails  (batch content fetch)
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_emails',
    {
      title: 'Get multiple emails',
      description:
        'Fetch the full content of multiple emails in a single call (max 20). ' +
        'More efficient than calling get_email repeatedly when triaging or summarising several emails. ' +
        'Does NOT mark emails as seen. ' +
        'Defaults to format="text" (HTML stripped) for compact, AI-friendly output. ' +
        'Each message carries the same 📰 newsletter / 🤖 automated marker as get_email.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        ids: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Email IDs to fetch (max 20). Obtain IDs from list_emails or search_emails.'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
        format: z
          .enum(['full', 'text', 'stripped'])
          .default('text')
          .describe(
            'Body format (default: text — HTML converted to readable text with markdown links). Use stripped to also remove quoted replies.',
          ),
        maxLength: z.coerce
          .number()
          .int()
          .min(0)
          .default(DEFAULT_MULTI_BODY_MAX)
          .describe(
            `Truncate each email body at this many characters (default ${DEFAULT_MULTI_BODY_MAX}; 0 = unlimited).`,
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, ids, mailbox, format, maxLength }) => {
      const results: string[] = [];
      const errors: string[] = [];

      const settled = await Promise.allSettled(
        ids.map(async (emailId) => mailReadService.getEmail(account, emailId, mailbox)),
      );

      settled.forEach((outcome, i) => {
        const emailId = ids[i];
        if (outcome.status === 'fulfilled') {
          const email = outcome.value;
          const from = email.from.name
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;
          const body = applyBodyFormat(
            email.bodyText,
            email.bodyHtml,
            format as BodyFormat,
            maxLength,
          );
          const attachLine =
            email.attachments.length > 0 ? `📎 ${describeAttachments(email.attachments)}` : '';
          const bulkLine = formatBulk(email.bulk);

          results.push(
            [
              `━━━ [${emailId}] ${email.subject}`,
              `Status: ${formatEmailStatus(email)}`,
              `From:   ${from}`,
              `Date:   ${email.date}`,
              bulkLine ? `Bulk:   ${bulkLine}` : '',
              attachLine,
              '',
              body,
            ]
              .filter((l) => l !== '')
              .join('\n'),
          );
        } else {
          const err = outcome.reason as unknown;
          errors.push(`[${emailId}] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      const errSuffix = errors.length > 0 ? `, ${errors.length} error(s)` : '';
      const summary = `📬 [${mailbox}] ${results.length} email(s) fetched${errSuffix}`;

      const parts: string[] = [summary, '', ...results];
      if (errors.length > 0) {
        parts.push('', '--- Errors ---', ...errors);
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // get_email_status  (lightweight flag/label check — no body fetch)
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_email_status',
    {
      title: 'Get email status',
      description:
        'Get the current read/flag/label state of an email without fetching its body. ' +
        'Much cheaper than get_email when you only need to check whether an email is unread, ' +
        'flagged, or which labels it has. ' +
        'Also useful to confirm the result of a mark_email call. ' +
        'Does NOT mark the email as seen.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID from list_emails or search_emails'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      }),
      outputSchema: emailStatusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, emailId, mailbox }) => {
      try {
        const flags = await mailReadService.getEmailFlags(account, emailId, mailbox);

        const statusParts: string[] = [flags.seen ? '✓ Read' : '🔵 Unread'];
        if (flags.flagged) statusParts.push('⭐ Flagged');
        if (flags.answered) statusParts.push('↩️ Replied');

        const lines = [
          `📊 Email Status`,
          `ID:      ${emailId} | Mailbox: ${mailbox}`,
          `Subject: ${flags.subject}`,
          `From:    ${flags.from}`,
          `Date:    ${flags.date}`,
          `Status:  ${statusParts.join(' · ')}`,
          `Labels:  ${flags.labels.length > 0 ? flags.labels.join(', ') : '(none)'}`,
        ];

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            id: emailId,
            mailbox,
            subject: flags.subject,
            from: flags.from,
            date: flags.date,
            seen: flags.seen,
            flagged: flags.flagged,
            answered: flags.answered,
            labels: flags.labels,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // search_emails
  // ---------------------------------------------------------------------------
  server.registerTool(
    'search_emails',
    {
      title: 'Search emails',
      description:
        'Search emails by keyword across subject, sender, and body — and, where the local ' +
        'mirror is enabled, attachment filenames (searching "report" finds an email carrying ' +
        'Q3-report.pdf). ' +
        'Omit query (or pass an empty string) to use it as a pure filter — e.g. find all emails ' +
        'from a specific sender without a keyword. ' +
        'Supports additional filters for sender, recipient, date range (since/before — INTERNALDATE; ' +
        'sent_since/sent_before — Date: header), attachments, size, and reply status. ' +
        'At least one of query/from/to/since/before/sent_since/sent_before/has_attachment/' +
        'larger_than/smaller_than/answered must be set; otherwise the call errors ' +
        '(use list_emails to browse without filters). ' +
        'Results carry the same 📰 newsletter / 🤖 automated markers as list_emails.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        query: z
          .string()
          .optional()
          .default('')
          .describe('Search keyword across subject, sender, and body (omit to use filters only)'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
        page: z.coerce.number().int().min(1).default(1).describe('Page number'),
        pageSize: z.coerce.number().int().min(1).max(100).default(20).describe('Results per page'),
        from: z.string().optional().describe('Filter by sender address (substring match)'),
        to: z.string().optional().describe('Filter by recipient address'),
        since: z
          .string()
          .optional()
          .describe(
            'Only emails received on/after this date (ISO 8601, e.g. 2026-05-11T00:00:00Z)',
          ),
        before: z.string().optional().describe('Only emails received before this date (ISO 8601)'),
        sent_since: z
          .string()
          .optional()
          .describe('Only emails with Date: header on/after this date (ISO 8601)'),
        sent_before: z
          .string()
          .optional()
          .describe('Only emails with Date: header before this date (ISO 8601)'),
        has_attachment: z
          .boolean()
          .optional()
          .describe('Filter: true=has attachments, false=no attachments'),
        larger_than: z.coerce.number().optional().describe('Minimum email size in KB'),
        smaller_than: z.coerce.number().optional().describe('Maximum email size in KB'),
        answered: z.boolean().optional().describe('Filter: true=replied, false=not replied'),
        preview: z
          .boolean()
          .default(false)
          .describe(
            'Include a ~200 character body preview per message. Off by default: it fetches extra bytes per message and lengthens the output.',
          ),
      }),
      outputSchema: emailListOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (params) => {
      try {
        const result = await mailReadService.searchEmails(params.account, params.query ?? '', {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          from: params.from,
          to: params.to,
          since: params.since,
          before: params.before,
          sentSince: params.sent_since,
          sentBefore: params.sent_before,
          hasAttachment: params.has_attachment,
          largerThan: params.larger_than,
          smallerThan: params.smaller_than,
          answered: params.answered,
          preview: params.preview,
        });

        if (result.items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: params.query
                  ? `No emails found matching "${params.query}".`
                  : 'No emails found matching the specified filters.',
              },
            ],
            structuredContent: {
              account: params.account,
              mailbox: params.mailbox,
              total: 0,
              page: params.page,
              pageSize: params.pageSize,
              hasMore: false,
              count: 0,
              emails: [],
            },
          };
        }

        const queryLabel = params.query ? `"${params.query}"` : 'filters';
        const header =
          `🔍 [${params.mailbox}] ${result.total} result(s) for ${queryLabel} ` +
          `(page ${result.page}/${Math.ceil(result.total / result.pageSize)})\n`;
        const emails = result.items.map(formatEmailMeta).join('\n\n');

        return {
          content: [{ type: 'text' as const, text: `${header}\n${emails}` }],
          structuredContent: {
            account: params.account,
            mailbox: params.mailbox,
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            hasMore: result.hasMore,
            count: result.items.length,
            emails: result.items,
            ...(result.cache ? { cache: result.cache } : {}),
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to search emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
