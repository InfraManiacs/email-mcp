import type { ServerConfig } from '../types/index.js';
import { parseOptions } from './http.js';

vi.mock('../app.js', () => ({
  buildServices: vi.fn(() => {
    throw new Error('buildServices must not run for --help');
  }),
  buildServer: vi.fn(),
  startBackgroundServices: vi.fn(),
}));

const serverConfig: ServerConfig = {
  host: '10.0.0.5',
  port: 3299,
  path: '/email',
  token: 'config-token',
  allowedHosts: ['mail.example.com'],
};

describe('parseOptions rejects unknown flags', () => {
  // Silently ignoring them meant a typo'd --token started a networked email
  // server with no authentication at all, and a typo'd --insecure refused to
  // start for reasons the message did not explain.
  it('throws on a misspelled option instead of ignoring it', () => {
    expect(() => parseOptions(['--toekn', 'secret'], {})).toThrow(/Unknown option/);
  });

  it('names the offending option', () => {
    expect(() => parseOptions(['--insecrue'], {})).toThrow(/--insecrue/);
  });

  it('rejects a stray positional argument', () => {
    expect(() => parseOptions(['8080'], {})).toThrow(/Unknown option/);
  });

  it('accepts every documented option', () => {
    expect(() =>
      parseOptions(
        [
          '--host',
          '127.0.0.1',
          '--port',
          '9000',
          '--path',
          '/mcp',
          '--token',
          't',
          '--allowed-hosts',
          'a.example.com,b.example.com',
          '--insecure',
        ],
        {},
      ),
    ).not.toThrow();
  });

  // runHttp short-circuits these before parseOptions, but server-commands
  // forwards unrecognized flags here, so they must not become a hard error.
  it('tolerates the help flags', () => {
    expect(() => parseOptions(['--help'], {})).not.toThrow();
    expect(() => parseOptions(['-h'], {})).not.toThrow();
  });
});

describe('parseOptions precedence', () => {
  it('uses hardcoded defaults when nothing else is provided', () => {
    const opts = parseOptions([], {});
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(8080);
    expect(opts.path).toBe('/mcp');
    expect(opts.token).toBeUndefined();
  });

  it('reads the [settings.server] layer', () => {
    const opts = parseOptions([], {}, serverConfig);
    expect(opts.host).toBe('10.0.0.5');
    expect(opts.port).toBe(3299);
    expect(opts.path).toBe('/email');
    expect(opts.token).toBe('config-token');
    expect(opts.allowedHosts).toEqual(['mail.example.com']);
  });

  it('lets env override config and flags override env', () => {
    const env = { EMAIL_MCP_HTTP_PORT: '9001', EMAIL_MCP_HTTP_TOKEN: 'env-token' };
    const envOpts = parseOptions([], env, serverConfig);
    expect(envOpts.port).toBe(9001);
    expect(envOpts.token).toBe('env-token');

    const flagOpts = parseOptions(['--port', '3199', '--token', 'flag-token'], env, serverConfig);
    expect(flagOpts.port).toBe(3199);
    expect(flagOpts.token).toBe('flag-token');
  });

  it('treats an empty config token as no auth', () => {
    const opts = parseOptions([], {}, { ...serverConfig, token: '' });
    expect(opts.token).toBeUndefined();
  });
});

describe('runHttp --help', () => {
  it('prints usage and returns without booting services', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { default: runHttp } = await import('./http.js');

    await expect(runHttp(['--help'])).resolves.toBeUndefined();
    await expect(runHttp(['-h'])).resolves.toBeUndefined();

    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain('Usage: email-mcp http');
    log.mockRestore();
  });
});
