/**
 * MCP tool: download_attachment
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type MailReadService from '../services/mail-read.service.js';

export default function registerAttachmentTools(
  server: McpServer,
  mailReadService: MailReadService,
): void {
  server.registerTool(
    'download_attachment',
    {
      title: 'Download attachment',
      description:
        'Download an email attachment by filename or part id. First use get_email to see available ' +
        'attachments with their filenames and partIds (partId is unambiguous — use it for duplicate ' +
        'filenames and inline cid images). Returns base64-encoded content for files ≤5MB.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        id: z.string().describe('Email ID (UID) from list_emails or get_email'),
        mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
        filename: z
          .string()
          .optional()
          .describe('Exact attachment filename (from get_email metadata)'),
        partId: z
          .string()
          .optional()
          .describe('MIME part id from get_email metadata (takes precedence over filename)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, id, mailbox, filename, partId }) => {
      try {
        if (filename === undefined && partId === undefined) {
          throw new Error('Provide filename or partId (see get_email attachment metadata)');
        }
        const result = await mailReadService.downloadAttachment(account, id, mailbox, {
          ...(filename !== undefined ? { filename } : {}),
          ...(partId !== undefined ? { partId } : {}),
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  filename: result.filename,
                  mimeType: result.mimeType,
                  size: result.size,
                  sizeHuman: `${Math.round(result.size / 1024)}KB`,
                },
                null,
                2,
              ),
            },
            {
              type: 'text' as const,
              text: `\n--- Base64 Content ---\n${result.contentBase64}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to download attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
