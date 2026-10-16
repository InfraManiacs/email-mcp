/**
 * MCP Tool: check_health
 *
 * Connection health diagnostics for email accounts.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type BlobStore from '../cache/blob-store.js';
import type CacheStore from '../cache/store.js';
import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';
import type MailReadService from '../services/mail-read.service.js';

/** The local-mirror slice of check_health; absent when caching is disabled. */
function cacheHealth(
  mailReadService: MailReadService,
  cacheStore?: CacheStore,
  blobStore?: BlobStore,
): Record<string, unknown> {
  if (!cacheStore) return { enabled: false };

  const stats = cacheStore.getStats();
  const metrics = mailReadService.getMetrics();
  const servedFromCache = metrics.hits + metrics.validatedHits;
  const totalReads = servedFromCache + metrics.syncedReads + metrics.liveFallbacks;

  return {
    enabled: true,
    messages: stats.messageCount,
    bodies: stats.bodyCount,
    attachments: stats.attachmentCount,
    index_bytes: stats.sizeBytes,
    attachment_bytes: blobStore?.sizeBytes() ?? stats.attachmentBytes,
    mailboxes: stats.mailboxes.map((mb) => ({
      account: mb.account,
      mailbox: mb.mailbox,
      cached_messages: mb.cachedMessages,
      total_messages: mb.totalMessages,
      bodies_cached: mb.bodiesCached,
      sync_tier: mb.syncTier,
      last_synced_age_ms: mb.lastSyncedAt === undefined ? null : Date.now() - mb.lastSyncedAt,
    })),
    reads: {
      ...metrics,
      // Share of reads answered without waiting on the mail server.
      hit_ratio: totalReads === 0 ? null : Number((servedFromCache / totalReads).toFixed(3)),
    },
  };
}

export default function registerHealthTools(
  server: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
  mailReadService: MailReadService,
  cacheStore?: CacheStore,
  blobStore?: BlobStore,
): void {
  server.registerTool(
    'check_health',
    {
      title: 'Check health',
      description:
        'Check connection health, quota, and capabilities for email accounts, plus local cache ' +
        'size, coverage and hit ratio. Useful for diagnosing issues.',
      inputSchema: z.object({
        account: z.string().optional().describe('Account name (checks all accounts if omitted)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account }) => {
      const names = account ? [account] : connections.getAccountNames();

      const results = await Promise.all(
        names.map(async (name) => {
          const cfg = connections.getAccount(name);
          const result: Record<string, unknown> = {
            name,
            auth_type: cfg.oauth2 ? 'oauth2' : 'password',
          };

          // IMAP health
          try {
            const start = Date.now();
            await connections.getImapClient(name);
            const latency = Date.now() - start;

            const capabilities = await imapService.getCapabilities(name);
            const quota = await imapService.getQuota(name);

            result.imap = {
              connected: true,
              latency_ms: latency,
              host: cfg.imap.host,
              capabilities: capabilities.slice(0, 20),
              tls: cfg.imap.tls,
            };

            if (quota) {
              result.quota = {
                used_mb: quota.usedMb,
                total_mb: quota.totalMb,
                percentage: quota.percentage,
              };
            }
          } catch (err) {
            result.imap = {
              connected: false,
              error: err instanceof Error ? err.message : String(err),
              host: cfg.imap.host,
            };
          }

          // SMTP health
          try {
            const start = Date.now();
            await connections.verifySmtpTransport(name);
            const latency = Date.now() - start;

            result.smtp = {
              connected: true,
              latency_ms: latency,
              host: cfg.smtp.host,
              tls: cfg.smtp.tls,
            };
          } catch (err) {
            result.smtp = {
              connected: false,
              error: err instanceof Error ? err.message : String(err),
              host: cfg.smtp.host,
            };
          }

          return result;
        }),
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { accounts: results, cache: cacheHealth(mailReadService, cacheStore, blobStore) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
