/**
 * CLI cache subcommands: status, clear, verify.
 *
 * The local mirror is invisible by design — it just makes reads fast and
 * keeps mail readable offline. These commands are how a user sees what it
 * holds, how much disk it costs, and how to reclaim that space.
 *
 * Everything here is safe: the mirror is regenerable, so `clear` costs time
 * (a resync) and never data.
 */

import { confirm, isCancel } from '@clack/prompts';

import BlobStore from '../cache/blob-store.js';
import { collectOrphans } from '../cache/maintenance.js';
import CacheStore, { type CacheStats } from '../cache/store.js';
import { loadConfig } from '../config/loader.js';
import { CACHE_BLOBS_DIR, CACHE_DB } from '../config/xdg.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export type CacheSubcommand = 'status' | 'clear' | 'verify';

export interface CacheArgs {
  subcommand: CacheSubcommand;
  account?: string;
  json: boolean;
  yes: boolean;
  help: boolean;
  error?: string;
}

const SUBCOMMANDS: CacheSubcommand[] = ['status', 'clear', 'verify'];

export function parseCacheArgs(argv: string[]): CacheArgs {
  const args: CacheArgs = { subcommand: 'status', json: false, yes: false, help: false };

  let i = 0;
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (!SUBCOMMANDS.includes(first as CacheSubcommand)) {
      return {
        ...args,
        error: `Unknown cache subcommand "${first}". Expected: ${SUBCOMMANDS.join(', ')}.`,
      };
    }
    args.subcommand = first as CacheSubcommand;
    i = 1;
  }

  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg.startsWith('--account=')) args.account = arg.slice('--account='.length);
    else if (arg === '--account') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ...args, error: '--account needs an account name.' };
      }
      args.account = value;
      i += 1;
    } else return { ...args, error: `Unknown option "${arg}".` };
  }

  return args;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Human-readable age, so "when did this last sync" reads at a glance. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return 'never';
  if (ms < 45_000) return 'just now';

  const units: [number, string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];
  for (const [size, label] of units) {
    if (ms >= size) {
      // Floor, not round: 90 seconds ago reads as "1 minute ago", never as
      // "2 minutes ago" — an age must never overstate how stale something is.
      const n = Math.floor(ms / size);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export interface CacheSettingsView {
  enabled: boolean;
  maxSizeMb: number;
  mailboxes: string[];
}

/** Render `cache status` for a terminal. */
export function formatCacheStatus(stats: CacheStats, settings: CacheSettingsView): string {
  const lines: string[] = ['📦 Email cache', ''];

  if (!settings.enabled) {
    lines.push(
      '⚠️  Caching is disabled — every read goes straight to the mail server.',
      '   Enable it with:  email-mcp config edit   (setting: cache.enabled)',
      '',
    );
  }

  const totalBytes = stats.sizeBytes + stats.attachmentBytes;
  const budgetBytes = settings.maxSizeMb * 1024 * 1024;

  if (settings.maxSizeMb > 0) {
    const pct = budgetBytes > 0 ? Math.round((totalBytes / budgetBytes) * 100) : 0;
    lines.push(`Size      ${formatBytes(totalBytes)} of ${settings.maxSizeMb} MB budget (${pct}%)`);
    if (totalBytes >= budgetBytes * 0.9) {
      lines.push(
        '          ⚠️  At the budget — the oldest attachments and bodies get evicted first.',
      );
    }
  } else {
    lines.push(`Size      ${formatBytes(totalBytes)} (budget: unlimited)`);
  }

  lines.push(
    `          ${formatBytes(stats.sizeBytes)} index + ${formatBytes(stats.attachmentBytes)} in ${stats.attachmentCount} attachment(s)`,
    `Contents  ${stats.messageCount} message(s), ${stats.bodyCount} with full text`,
    `Location  ${CACHE_DB}`,
    '',
  );

  if (stats.mailboxes.length === 0) {
    lines.push(
      'Nothing cached yet — the mirror fills in the background once the server runs.',
      `Mailboxes configured for caching: ${settings.mailboxes.join(', ') || '(none)'}`,
    );
    return lines.join('\n');
  }

  lines.push('Mailboxes');
  for (const mb of stats.mailboxes) {
    const coverage =
      mb.totalMessages === undefined
        ? `${mb.cachedMessages} cached`
        : `${mb.cachedMessages}/${mb.totalMessages} cached`;
    const age = formatDuration(
      mb.lastSyncedAt === undefined ? undefined : Date.now() - mb.lastSyncedAt,
    );
    lines.push(
      `  ${mb.account}/${mb.mailbox}`,
      `    ${coverage} · ${mb.bodiesCached} with full text · sync: ${mb.syncTier} · last synced ${age}`,
    );
  }

  lines.push('', 'Reclaim the space with:  email-mcp cache clear');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const HELP = `Usage: email-mcp cache <subcommand> [options]

Inspect and reclaim the local mail cache. The cache only makes reads faster
and keeps mail readable while offline — clearing it never loses mail.

Subcommands:
  status            Show what is cached, how fresh it is, and how much disk it uses (default)
  clear             Delete the cached mail and attachments; they are re-fetched on demand
  verify            Check the cache for corruption and reclaim orphaned files

Options:
  --account <name>  Limit "clear" to one account
  --json            Machine-readable output (for scripts)
  --yes, -y         Skip the confirmation prompt for "clear"
  --help, -h        Show this help

Examples:
  email-mcp cache status                 # How big is it, and how fresh?
  email-mcp cache status --json          # Same, for scripts
  email-mcp cache clear                  # Free the disk space (asks first)
  email-mcp cache clear --account work   # Only this account
  email-mcp cache verify                 # Integrity check + reclaim orphans`;

interface CacheHandles {
  store: CacheStore;
  blobs: BlobStore;
  settings: CacheSettingsView;
}

/**
 * Cache settings, defaulted when no usable config exists.
 *
 * Reclaiming local disk or inspecting what is cached must not require working
 * mail credentials: the cache is a local artifact that outlives any account,
 * and a user whose config is missing or broken still needs to be able to
 * clear it. The defaults mirror `CacheConfigSchema`.
 */
export async function resolveCacheSettings(
  load: typeof loadConfig = loadConfig,
): Promise<CacheSettingsView> {
  try {
    const { enabled, maxSizeMb, mailboxes } = (await load()).settings.cache;
    return { enabled, maxSizeMb, mailboxes };
  } catch {
    return { enabled: true, maxSizeMb: 500, mailboxes: ['INBOX'] };
  }
}

async function open(): Promise<CacheHandles> {
  return {
    store: new CacheStore(CACHE_DB),
    blobs: new BlobStore(CACHE_BLOBS_DIR),
    settings: await resolveCacheSettings(),
  };
}

async function runStatus(args: CacheArgs): Promise<void> {
  const { store, blobs, settings } = await open();
  try {
    const stats = store.getStats();
    // The index records the sizes it stored; the directory is the truth about
    // what is on disk, and the two can differ if the cache dir was wiped.
    const onDiskBytes = blobs.sizeBytes();

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            enabled: settings.enabled,
            budgetMb: settings.maxSizeMb,
            cachedMailboxes: settings.mailboxes,
            dbPath: CACHE_DB,
            blobsPath: CACHE_BLOBS_DIR,
            indexBytes: stats.sizeBytes,
            attachmentBytes: stats.attachmentBytes,
            attachmentBytesOnDisk: onDiskBytes,
            totalBytes: stats.sizeBytes + stats.attachmentBytes,
            messageCount: stats.messageCount,
            bodyCount: stats.bodyCount,
            attachmentCount: stats.attachmentCount,
            mailboxes: stats.mailboxes,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(formatCacheStatus({ ...stats, attachmentBytes: onDiskBytes }, settings));
  } finally {
    store.close();
  }
}

async function runClear(args: CacheArgs): Promise<void> {
  const { store, blobs, settings } = await open();
  try {
    const before = store.getStats();
    const scope = args.account ? `account "${args.account}"` : 'all accounts';
    const freeable = before.sizeBytes + blobs.sizeBytes();

    // Blob files can outlive the index — a schema bump recreates the database
    // file and leaves every attachment behind as an orphan. Refusing to run
    // here would make that disk permanently unreclaimable through the CLI.
    const strayBlobs = blobs.list().length;
    if (before.messageCount === 0 && before.attachmentCount === 0 && strayBlobs === 0) {
      console.log('Nothing to clear — the cache is already empty.');
      return;
    }

    if (!args.yes && process.stdin.isTTY) {
      const proceed = await confirm({
        message: `Clear the cache for ${scope}? ${before.messageCount} message(s), ~${formatBytes(freeable)}. Mail is re-fetched on demand.`,
        initialValue: true,
      });
      if (isCancel(proceed) || !proceed) {
        console.log('Left the cache untouched.');
        return;
      }
    }

    store.clear(args.account);
    // Clearing the index makes every blob an orphan; this is what frees disk.
    const removedBlobs = await collectOrphans(store, blobs);
    store.incrementalVacuum();
    store.checkpoint();

    const after = store.getStats();
    const freed = freeable - (after.sizeBytes + blobs.sizeBytes());

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            cleared: scope,
            messagesRemoved: before.messageCount - after.messageCount,
            attachmentsRemoved: removedBlobs,
            bytesFreed: Math.max(0, freed),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      [
        `✅ Cleared the cache for ${scope}.`,
        `   ${before.messageCount - after.messageCount} message(s) and ${removedBlobs} attachment file(s) removed`,
        `   ~${formatBytes(Math.max(0, freed))} freed`,
        settings.enabled
          ? '   It refills in the background as you read mail.'
          : '   Caching is disabled, so it will stay empty until you enable it.',
      ].join('\n'),
    );
  } finally {
    store.close();
  }
}

async function runVerify(args: CacheArgs): Promise<void> {
  const { store, blobs } = await open();
  try {
    const integrity = store.checkIntegrity();
    const orphansRemoved = await collectOrphans(store, blobs);
    store.incrementalVacuum();

    if (args.json) {
      console.log(JSON.stringify({ ...integrity, orphansRemoved }, null, 2));
      return;
    }

    const lines = ['🔍 Cache verification', ''];
    lines.push(
      integrity.ok
        ? '✅ Index and search index are consistent.'
        : `❌ Problems found:\n   ${integrity.problems.join('\n   ')}`,
    );
    lines.push(
      orphansRemoved > 0
        ? `🧹 Reclaimed ${orphansRemoved} orphaned attachment file(s).`
        : '🧹 No orphaned attachment files.',
    );
    if (!integrity.ok) {
      lines.push('', 'Run `email-mcp cache clear` to rebuild from scratch.');
    }
    console.log(lines.join('\n'));
  } finally {
    store.close();
  }
}

export default async function runCacheCommand(argv: string[]): Promise<void> {
  const args = parseCacheArgs(argv);

  if (args.error) {
    console.error(`❌ ${args.error}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  try {
    if (args.subcommand === 'status') await runStatus(args);
    else if (args.subcommand === 'clear') await runClear(args);
    else await runVerify(args);
  } catch (err) {
    console.error(`❌ Cache command failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
