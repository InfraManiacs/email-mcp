import runEmailCommand from './email-commands.js';

/**
 * --help must answer without touching the network. If runEmailCommand tried to
 * build services it would call loadConfig()/connect — so a passing --help test
 * also proves the short-circuit happens before any connection attempt.
 */
describe('runEmailCommand --help', () => {
  it('prints per-command usage and never connects', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runEmailCommand('list', ['--help'])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(/email-mcp list/);
    log.mockRestore();
  });

  it('supports -h as well', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runEmailCommand('send', ['-h']);
    expect(log.mock.calls.flat().join('\n')).toMatch(/--to/);
    log.mockRestore();
  });

  it('reports an unknown command without connecting', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runEmailCommand('frobnicate', []);
    expect(err.mock.calls.flat().join('\n')).toMatch(/Unknown email command/);
    err.mockRestore();
  });
});
