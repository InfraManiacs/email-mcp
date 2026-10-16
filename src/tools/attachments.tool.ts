/**
 * MCP tool: download_attachment
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';
import type MailReadService from '../services/mail-read.service.js';
import type { AttachmentDownloadConfig } from '../types/index.js';

export default function registerAttachmentTools(
  server: McpServer,
  mailReadService: MailReadService,
  imapService: ImapService,
  attachmentDownloadConfig: AttachmentDownloadConfig,
): void {
  const downloadDirNote = attachmentDownloadConfig.dir
    ? `Set saveToDownloadDir=true to also (or instead) write the file under the server-configured ` +
      `download directory — allowed extensions: ${attachmentDownloadConfig.allowedExtensions.join(', ')}. ` +
      `Optionally pass saveAs to choose the filename written there.`
    : 'saveToDownloadDir is unavailable — no attachment download directory is configured on this server.';

  server.registerTool(
    'download_attachment',
    {
      title: 'Download attachment',
      description:
        'Download an email attachment by filename or part id. First use get_email to see available ' +
        'attachments with their filenames and partIds (partId is unambiguous — use it for duplicate ' +
        `filenames and inline cid images). Returns base64-encoded content for files ≤5MB. ${downloadDirNote}`,
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
        saveToDownloadDir: z
          .boolean()
          .default(false)
          .describe(
            'Write the attachment to the server-configured download directory instead of ' +
              'returning it base64-encoded. Fails if no download directory is configured.',
          ),
        saveAs: z
          .string()
          .optional()
          .describe(
            'Filename to save as under the download directory (basename only, no path ' +
              'separators). Only used with saveToDownloadDir; defaults to the attachment’s own filename.',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, id, mailbox, filename, partId, saveToDownloadDir, saveAs }) => {
      try {
        if (filename === undefined && partId === undefined) {
          throw new Error('Provide filename or partId (see get_email attachment metadata)');
        }
        if (saveAs !== undefined && !saveToDownloadDir) {
          throw new Error('saveAs requires saveToDownloadDir=true');
        }
        const selector = {
          ...(filename !== undefined ? { filename } : {}),
          ...(partId !== undefined ? { partId } : {}),
        };

        if (saveToDownloadDir) {
          const result = await imapService.downloadAttachmentToDownloadDir(
            account,
            id,
            mailbox,
            selector,
            attachmentDownloadConfig,
            saveAs,
          );
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
                    path: result.path,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const result = await mailReadService.downloadAttachment(account, id, mailbox, selector);

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
