/**
 * Log viewer for `email-mcp logs` (and `email-mcp server logs`). Reads the
 * daemon log, with optional level/substring filtering, colorization, and a
 * `--follow` live tail. Pure helpers (filter, colorize) are unit-tested; the
 * orchestrator does the I/O.
 *
 * Daemon log lines look like:
 *   2026-10-10T08:00:00.000Z INFO [imap] Connected ...
 */

import { createReadStream } from 'node:fs';
import { stat, watch } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { DAEMON_LOG_FILE } from '../config/xdg.js';

/** Severity order, low → high. `--level warn` keeps warn and error. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

interface FilterOpts {
  level?: string;
  grep?: string;
}

const LEVEL_TOKEN = /\b(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\b/;

/** Normalize a log token to our 4-level scale (null if unknown). */
function lineLevelIndex(line: string): number | null {
  const m = line.match(LEVEL_TOKEN);
  if (!m?.[1]) return null;
  const t = m[1].toLowerCase();
  if (t === 'trace') return 0; // debug-ish
  if (t === 'warning') return LOG_LEVELS.indexOf('warn');
  if (t === 'fatal') return LOG_LEVELS.indexOf('error');
  const idx = LOG_LEVELS.indexOf(t as LogLevel);
  return idx === -1 ? null : idx;
}

/**
 * Filter log text by a severity threshold and/or a case-insensitive substring.
 * Continuation lines (no level token — stack traces, wrapped messages) are kept
 * when the line before them was kept, so multi-line entries stay intact.
 */
export function filterLogLines(text: string, opts: FilterOpts): string {
  const threshold = opts.level ? LOG_LEVELS.indexOf(opts.level.toLowerCase() as LogLevel) : -1;
  const grep = opts.grep?.toLowerCase();
  let keptPrevious = false;

  return text
    .split('\n')
    .filter((line) => {
      if (line === '') return false;
      const idx = lineLevelIndex(line);

      // Level gate. A continuation (no level token) rides on the previous line.
      let levelOk: boolean;
      if (threshold === -1) {
        levelOk = true;
      } else if (idx === null) {
        levelOk = keptPrevious;
      } else {
        levelOk = idx >= threshold;
      }

      const grepOk = !grep || line.toLowerCase().includes(grep) || (idx === null && keptPrevious);

      const keep = levelOk && grepOk;
      // Only a real (level-bearing) line updates the continuation anchor.
      if (idx !== null) keptPrevious = keep;
      return keep;
    })
    .join('\n');
}

const RESET = '\x1b[0m';
const COLORS: Record<string, string> = {
  error: '\x1b[31m', // red
  warn: '\x1b[33m', // yellow
  debug: '\x1b[2m', // dim
};

/** Colorize a line by its level (ERROR red, WARN yellow, DEBUG dim). */
export function colorizeLogLine(line: string, opts: { color: boolean }): string {
  if (!opts.color) return line;
  const idx = lineLevelIndex(line);
  if (idx === null) return line;
  const level = LOG_LEVELS[idx];
  const color = level ? COLORS[level] : undefined;
  return color ? `${color}${line}${RESET}` : line;
}

/** Last `n` lines of a string. */
function tail(text: string, n: number): string {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

async function readFileText(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (c) => chunks.push(c as Buffer))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      .on('error', reject);
  });
}

/**
 * `email-mcp logs [-n N] [-f] [--level L] [--grep TEXT]`
 */
export default async function runLogs(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      lines: { type: 'string', short: 'n', default: '40' },
      follow: { type: 'boolean', short: 'f', default: false },
      level: { type: 'string' },
      grep: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.level && !LOG_LEVELS.includes(values.level.toLowerCase() as LogLevel)) {
    console.error(`Invalid --level "${values.level}". One of: ${LOG_LEVELS.join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const filterOpts = { level: values.level, grep: values.grep };
  const render = (text: string) =>
    filterLogLines(text, filterOpts)
      .split('\n')
      .filter(Boolean)
      .map((l) => colorizeLogLine(l, { color }))
      .join('\n');

  let initial: string;
  try {
    initial = await readFileText(DAEMON_LOG_FILE);
  } catch {
    console.log(`No log file yet at ${DAEMON_LOG_FILE}.`);
    if (!values.follow) return;
    initial = '';
  }

  const tailed = render(tail(initial, Number(values.lines)));
  if (tailed) console.log(tailed);

  if (!values.follow) return;

  // Live tail: re-read appended bytes whenever the file changes. Handles
  // truncation/rotation by resetting the read offset when the file shrinks.
  console.log(
    color
      ? `\x1b[2m— following ${DAEMON_LOG_FILE} (Ctrl-C to stop) —${RESET}`
      : `— following ${DAEMON_LOG_FILE} (Ctrl-C to stop) —`,
  );
  let offset = Buffer.byteLength(initial, 'utf-8');
  const watcher = watch(DAEMON_LOG_FILE);
  for await (const _event of watcher) {
    let size: number;
    try {
      size = (await stat(DAEMON_LOG_FILE)).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0; // rotated/truncated
    if (size <= offset) continue;
    const appended = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      createReadStream(DAEMON_LOG_FILE, { start: offset })
        .on('data', (c) => chunks.push(c as Buffer))
        .on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        .on('error', reject);
    });
    offset = size;
    const out = render(appended);
    if (out) console.log(out);
  }
}
