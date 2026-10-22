import type { Server } from 'node:http';

import type { AppServices } from '../app.js';
import type { ServerConfig } from '../types/index.js';
import { parseOptions, tokenMatches } from './http.js';

// Captures every real `http.Server` runHttp creates, so a test that boots a
// real listener can discover the ephemeral port it bound and close it
// afterwards — runHttp itself hands back neither.
const { capturedServers } = vi.hoisted(() => ({ capturedServers: [] as Server[] }));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      capturedServers.push(server);
      return server;
    },
  };
});

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

// The SDK's stateless transport is single-exchange: its own guard throws
// "Stateless transport cannot be reused across requests" on a second
// `handleRequest` call. runHttp built one transport at startup and reused it
// for every incoming request, so only ever the first request to the process
// worked — everything after 500'd. A bare GET (no `text/event-stream` in
// Accept) is enough to prove this: it 406s deterministically without needing
// a real MCP session, so the only thing a second request can still get wrong
// is the reused-transport crash.
describe('runHttp request handling', () => {
  afterEach(async () => {
    // buildServer is called once at startup plus once per request — reset
    // its queued implementation so it doesn't leak into other tests.
    const { buildServer } = await import('../app.js');
    vi.mocked(buildServer).mockReset();

    await Promise.all(
      capturedServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('serves a second request the same as the first instead of 500ing on a reused transport', async () => {
    const { buildServices, buildServer, startBackgroundServices } = await import('../app.js');
    const { default: createServer } = await import('../server.js');
    const { createServer: createNodeHttpServer } = await import('node:http');

    // Ask the OS for a free port up front — parseOptions rejects `--port 0`.
    const probe = createNodeHttpServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    // Only `config.settings.server` is read on this path (by parseOptions);
    // startBackgroundServices is mocked below instead of using the real
    // services this fake does not provide. buildServer is called once at
    // startup and once per request, so it needs a fresh McpServer every
    // call rather than a single queued return value.
    const fakeServices = { config: { settings: { server: undefined } } } as unknown as AppServices;
    vi.mocked(buildServices).mockResolvedValueOnce(fakeServices);
    vi.mocked(buildServer).mockImplementation(() => createServer());
    vi.mocked(startBackgroundServices).mockReturnValueOnce({
      stop: vi.fn().mockResolvedValue(undefined),
    });

    const { default: runHttp } = await import('./http.js');
    await runHttp(['--host', '127.0.0.1', '--port', String(port)]);

    const url = `http://127.0.0.1:${port}/mcp`;
    const first = await fetch(url, { headers: { Accept: 'application/json' } });
    await first.text();
    const second = await fetch(url, { headers: { Accept: 'application/json' } });
    await second.text();

    expect(first.status).toBe(406);
    expect(second.status).toBe(406);
  });
});

describe('tokenMatches', () => {
  const token = 'a'.repeat(40);
  const req = (headers: Record<string, string>) => ({ headers });

  it('accepts Authorization: Bearer', () => {
    expect(tokenMatches(req({ authorization: `Bearer ${token}` }), token)).toBe(true);
    expect(tokenMatches(req({ authorization: token }), token)).toBe(false);
  });

  it('accepts X-API-Key with or without the Bearer prefix', () => {
    expect(tokenMatches(req({ 'x-api-key': token }), token)).toBe(true);
    expect(tokenMatches(req({ 'x-api-key': ` Bearer ${token} ` }), token)).toBe(true);
    expect(tokenMatches(req({ 'x-api-key': 'wrong' }), token)).toBe(false);
  });

  it('falls back to X-API-Key when Authorization carries something else', () => {
    expect(
      tokenMatches(req({ authorization: 'Bearer client-oauth', 'x-api-key': token }), token),
    ).toBe(true);
    expect(tokenMatches(req({}), token)).toBe(false);
  });
});
