/**
 * MCP tool: get_thread
 *
 * Reconstructs an email conversation thread using References / In-Reply-To
 * header chains. Returns messages in chronological order (or newest-first).
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type MailReadService from '../services/mail-read.service.js';
import { applyBodyFormat, DEFAULT_MULTI_BODY_MAX } from '../utils/body-format.js';

// ---------------------------------------------------------------------------

export default function registerThreadTools(
  server: McpServer,
  mailReadService: MailReadService,
): void {
  server.registerTool(
    'get_thread',
    {
      title: 'Get thread',
      description:
        'Reconstruct a full email conversation thread by following References and In-Reply-To headers. ' +
        'Returns all related messages. Does NOT mark emails as seen. ' +
        'format: text (default) = HTML converted to readable text with [markdown](links); ' +
        'stripped = text minus quoted replies; full = raw body part. ' +
        `Each body is capped at ${DEFAULT_MULTI_BODY_MAX} chars by default — pass maxLength (0 = unlimited) to change. ` +
        'Use newestFirst=true to show the most recent message in full and older messages as header-only summaries. ' +
        'Use get_email first to obtain the message_id.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        message_id: z.string().describe('Message-ID header value (from get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox to search (default: INBOX)'),
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
          .default(DEFAULT_MULTI_BODY_MAX)
          .describe(
            `Truncate each message body at this many characters (default ${DEFAULT_MULTI_BODY_MAX}; 0 = unlimited). A hint shows how many characters remain.`,
          ),
        newestFirst: z
          .boolean()
          .default(false)
          .describe(
            'When true, shows the newest message in full and older messages as header-only summaries. ' +
              'Ideal for AI triage of long threads where only the latest reply matters.',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, message_id: messageId, mailbox, format, maxLength, newestFirst }) => {
      try {
        const thread = await mailReadService.getThread(account, messageId, mailbox);

        if (thread.messageCount === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No thread found for Message-ID: ${messageId}`,
              },
            ],
          };
        }

        const ordered = newestFirst ? [...thread.messages].reverse() : thread.messages;
        const total = thread.messageCount;

        const parts: string[] = [
          `🧵 Thread: ${total} message${total === 1 ? '' : 's'}`,
          `Thread-ID: ${thread.threadId}`,
          `Participants: ${thread.participants.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ')}`,
          '',
        ];

        ordered.forEach((email, idx) => {
          let label: string;
          if (newestFirst) {
            label = idx === 0 ? 'Latest message' : `Message ${total - idx} of ${total} (older)`;
          } else {
            label = `Message ${idx + 1} of ${total}`;
          }

          const from = email.from.name
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;

          parts.push(`--- ${label} ---`);
          parts.push(`From: ${from}`);
          parts.push(`To: ${email.to.map((a) => a.address).join(', ')}`);
          parts.push(`Date: ${email.date}`);
          parts.push(`Subject: ${email.subject}`);

          if (email.attachments.length > 0) {
            parts.push(`📎 ${email.attachments.map((a) => a.filename).join(', ')}`);
          }

          // In newestFirst mode, only render body for the newest (first) message
          if (newestFirst && idx > 0) {
            parts.push('(body omitted — use get_email to read this message)');
          } else {
            parts.push('');
            parts.push(applyBodyFormat(email.bodyText, email.bodyHtml, format, maxLength));
          }

          parts.push('');
        });

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get thread: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
