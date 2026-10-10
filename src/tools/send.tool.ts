/**
 * MCP tools: send_email, reply_email, forward_email
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { validateInputLength } from '../safety/validation.js';

import { formatSize, prepareAttachments } from '../services/attachments.js';
import type SmtpService from '../services/smtp.service.js';

/** One result line per attachment, so the caller sees exactly what went out. */
function attachmentReport(prepared: Awaited<ReturnType<typeof prepareAttachments>> | null): string {
  if (!prepared || prepared.attachments.length === 0) return '';
  const lines = prepared.attachments.map((a) => `  - ${a.filename} (${formatSize(a.size)})`);
  return `\n📎 Attachments (${prepared.attachments.length}, ${formatSize(prepared.totalBytes)} raw ≈ ${formatSize(prepared.totalEncodedBytes)} encoded):\n${lines.join('\n')}`;
}

export default function registerSendTools(
  server: McpServer,
  smtpService: SmtpService,
  maxAttachmentMb: number,
): void {
  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'send_email',
    {
      title: 'Send email',
      description: 'Send a new email. Supports plain text or HTML body, CC, and BCC.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
        bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
        html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
        attachments: z
          .array(z.string())
          .optional()
          .describe(
            `Local file paths to attach. Sizes are checked before sending; the base64-encoded total must stay under the configured limit (currently ${maxAttachmentMb} MB).`,
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        validateInputLength(params.subject, 998, 'Subject');
        validateInputLength(params.body, 5_000_000, 'Body');
        const prepared = params.attachments?.length
          ? await prepareAttachments(params.attachments, maxAttachmentMb)
          : null;
        const result = await smtpService.sendEmail(params.account, {
          ...params,
          attachments: prepared?.attachments,
        });
        await audit.log(
          'send_email',
          params.account,
          { to: params.to, subject: params.subject },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email sent successfully!\nTo: ${params.to.join(', ')}\nSubject: ${params.subject}\nMessage-ID: ${result.messageId}${attachmentReport(prepared)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'send_email',
          params.account,
          { to: params.to, subject: params.subject },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reply_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'reply_email',
    {
      title: 'Reply email',
      description:
        'Reply to an email with proper threading (In-Reply-To & References headers). Use get_email first to read the original.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID to reply to (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        body: z.string().describe('Reply body content'),
        replyAll: z.boolean().default(false).describe('Reply to all recipients'),
        html: z.boolean().default(false).describe('Send as HTML'),
        attachments: z
          .array(z.string())
          .optional()
          .describe(
            `Local file paths to attach. Sizes are checked before sending; the base64-encoded total must stay under the configured limit (currently ${maxAttachmentMb} MB).`,
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const prepared = params.attachments?.length
          ? await prepareAttachments(params.attachments, maxAttachmentMb)
          : null;
        const result = await smtpService.replyToEmail(params.account, {
          ...params,
          attachments: prepared?.attachments,
        });
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Reply sent successfully!\nMessage-ID: ${result.messageId}${attachmentReport(prepared)}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to reply: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'forward_email',
    {
      title: 'Forward email',
      description:
        'Forward an email to new recipients with optional additional message. Original email is quoted below and its attachments are re-attached unless includeAttachments is false.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID to forward (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        to: z.array(z.string().email()).min(1).describe('Forward to these recipients'),
        body: z.string().optional().describe('Additional message above the forwarded content'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
        includeAttachments: z
          .boolean()
          .default(true)
          .describe('Re-attach the original attachments (default: true)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const result = await smtpService.forwardEmail(params.account, params);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email forwarded successfully!\nTo: ${params.to.join(', ')}\nMessage-ID: ${result.messageId}${params.includeAttachments === false ? '\n(original attachments not included)' : ''}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to forward: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
