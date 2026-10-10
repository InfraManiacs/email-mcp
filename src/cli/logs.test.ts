import { colorizeLogLine, filterLogLines, LOG_LEVELS } from './logs.js';

const SAMPLE = [
  '2026-10-10T08:00:00.000Z INFO [imap] Connected to 127.0.0.1:1143',
  '2026-10-10T08:00:01.000Z WARNING [watcher] IDLE restart',
  '2026-10-10T08:00:02.000Z ERROR [smtp] send failed: timeout',
  '    at Object.<anonymous> (/app/x.js:1:1)',
  '2026-10-10T08:00:03.000Z DEBUG [cache] hit',
].join('\n');

describe('filterLogLines', () => {
  it('returns everything when no filter is given', () => {
    expect(filterLogLines(SAMPLE, {}).split('\n')).toHaveLength(5);
  });

  it('filters to a severity threshold (warn keeps WARNING + ERROR)', () => {
    const out = filterLogLines(SAMPLE, { level: 'warn' });
    expect(out).toContain('WARNING');
    expect(out).toContain('ERROR');
    expect(out).not.toContain('INFO');
    expect(out).not.toContain('DEBUG');
  });

  it('keeps continuation lines (stack traces) under a level filter', () => {
    const out = filterLogLines(SAMPLE, { level: 'error' });
    expect(out).toContain('ERROR [smtp]');
    expect(out).toContain('at Object.<anonymous>'); // continuation of the ERROR
    expect(out).not.toContain('WARNING');
  });

  it('greps a substring (case-insensitive), AND-combined with level', () => {
    expect(filterLogLines(SAMPLE, { grep: 'imap' })).toContain('Connected');
    expect(filterLogLines(SAMPLE, { grep: 'imap' })).not.toContain('watcher');
    expect(filterLogLines(SAMPLE, { grep: 'SMTP', level: 'error' })).toContain('send failed');
  });

  it('exposes the known levels in severity order', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

describe('colorizeLogLine', () => {
  it('is a no-op when color is off', () => {
    const line = SAMPLE.split('\n')[2];
    expect(colorizeLogLine(line, { color: false })).toBe(line);
  });

  it('wraps ERROR lines in red when color is on', () => {
    const out = colorizeLogLine(SAMPLE.split('\n')[2], { color: true });
    expect(out).toContain('\x1b[31m'); // red
    expect(out).toContain('send failed');
  });
});
