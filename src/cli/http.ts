/**
 * Streamable HTTP transport entry point ("Method 2", MCP spec 2026-07-28).
 *
 * Serves the same server graph as stdio over HTTP using the SDK v2 node
 * adapter's `NodeStreamableHTTPServerTransport` in stateless mode. Security:
 *   • DNS-rebinding protection via `Host` header validation.
 *   • Bearer-token auth (env `EMAIL_MCP_HTTP_TOKEN` or `--token`), via
 *     `Authorization: Bearer` or `X-API-Key`.
 *   • Refuses to bind a non-loopback interface without a token (use
 *     `--insecure` to override, e.g. when TLS + auth is terminated upstream).
 *
 * Run:  email-mcp http --port 8080            → http://127.0.0.1:8080/mcp
 *       email-mcp http --host 0.0.0.0 --port 8080 --token "$SECRET"
 */

import { timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  hostHeaderValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';

import { buildServer, buildServices, startBackgroundServices } from '../app.js';
import { isHubEnabled, loadHubConfig } from '../hub/config.js';
import Hub from '../hub/hub.js';
import AuthLimiter from '../safety/auth-limiter.js';
import type { ServerConfig } from '../types/index.js';

export interface HttpOptions {
  host: string;
  port: number;
  path: string;
  token?: string;
  allowedHosts: string[]; // empty ⇒ validation disabled (wildcard)
  insecure: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

/** Shortest bearer token accepted when listening beyond loopback. */
const MIN_NETWORK_TOKEN_LENGTH = 32;

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * Resolve `http` options with the layered precedence:
 * CLI flags → EMAIL_MCP_HTTP_* env → [settings.server] → built-in defaults.
 */
export function parseOptions(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  serverConfig?: ServerConfig,
): HttpOptions {
  const opts: HttpOptions = {
    host: env.EMAIL_MCP_HTTP_HOST ?? serverConfig?.host ?? '127.0.0.1',
    port: Number(env.EMAIL_MCP_HTTP_PORT ?? serverConfig?.port ?? 8080),
    path: env.EMAIL_MCP_HTTP_PATH ?? serverConfig?.path ?? '/mcp',
    // An empty config token means "no auth", same as an unset env var.
    token: env.EMAIL_MCP_HTTP_TOKEN ?? (serverConfig?.token ? serverConfig.token : undefined),
    allowedHosts: env.EMAIL_MCP_HTTP_ALLOWED_HOSTS
      ? env.EMAIL_MCP_HTTP_ALLOWED_HOSTS.split(',')
          .map((h) => h.trim())
          .filter(Boolean)
      : (serverConfig?.allowedHosts ?? []),
    insecure: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1] ?? '';
    switch (arg) {
      case '--host':
        opts.host = value;
        i += 1;
        break;
      case '--port':
        opts.port = Number(value);
        i += 1;
        break;
      case '--path':
        opts.path = value;
        i += 1;
        break;
      case '--token':
        opts.token = value;
        i += 1;
        break;
      case '--allowed-hosts':
        opts.allowedHosts = value
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--insecure':
        opts.insecure = true;
        break;
      // runHttp handles these before parsing, but `server start` forwards
      // anything it does not recognise here, so they must not hard-error.
      case '--help':
      case '-h':
        break;
      default:
        // Ignoring them cost more than the forward-compatibility it bought: a
        // typo'd --token left a networked email server with no authentication,
        // and a typo'd --insecure refused to bind for an unexplained reason.
        throw new Error(
          `Unknown option "${arg}" for \`email-mcp http\`. ` +
            'Valid options: --host, --port, --path, --token, --allowed-hosts, --insecure. ' +
            'Run `email-mcp http --help` for details.',
        );
    }
  }

  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  return opts;
}

/** Constant-time token comparison. */
function secretEquals(provided: string, token: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The token may arrive as `Authorization: Bearer <token>` or, for clients
 * that reserve Authorization for their own sign-in (Claude Desktop custom
 * connectors), as `X-API-Key: <token>`.
 */
export function tokenMatches(req: Pick<IncomingMessage, 'headers'>, token: string): boolean {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && secretEquals(auth.slice('Bearer '.length), token)) {
    return true;
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey !== 'string') return false;
  const value = apiKey.trim();
  return secretEquals(value.startsWith('Bearer ') ? value.slice('Bearer '.length) : value, token);
}

function printHttpUsage(): void {
  console.log(`Usage: email-mcp http [options]

Serve the MCP server over Streamable HTTP (loopback by default).

Options (precedence: flags > EMAIL_MCP_HTTP_* env > [settings.server] > defaults):
  --host <addr>            Bind address (default: 127.0.0.1)
  --port <n>               Port (default: 8080)
  --path <path>            Endpoint path (default: /mcp)
  --token <secret>         Require "Authorization: Bearer <secret>" (or "X-API-Key: <secret>")
  --allowed-hosts <a,b>    Host-header allowlist (default: loopback names)
  --insecure               Allow non-loopback bind without a token
  -h, --help               Show this help

Examples:
  email-mcp http --port 28080
  email-mcp http --host 0.0.0.0 --port 8443 --token "$SECRET"`);
}

export default async function runHttp(argv: string[]): Promise<void> {
  // Before anything with side effects: buildServices() starts background
  // services, so without this check `email-mcp http --help` used to boot the
  // full server (and die with EADDRINUSE if the daemon was already running).
  if (argv.includes('--help') || argv.includes('-h')) {
    printHttpUsage();
    return;
  }

  const services = await buildServices();
  const opts = parseOptions(argv, process.env, services.config.settings.server);

  // Safety: never expose a networked email server without authentication.
  if (!isLoopback(opts.host) && !opts.token && !opts.insecure) {
    throw new Error(
      `Refusing to bind ${opts.host} without authentication.\n` +
        `Set a token ([settings.server] token, EMAIL_MCP_HTTP_TOKEN, or --token) so requests ` +
        `must present "Authorization: Bearer <token>", or pass --insecure if auth/TLS is ` +
        `terminated by an upstream proxy.`,
    );
  }

  // Hub mode: admin UI + hosted OAuth, accounts connected at runtime.
  let hub: Hub | undefined;
  if (isHubEnabled()) {
    const hubConfig = loadHubConfig();
    hub = new Hub(hubConfig, services);
    await hub.init();
    const publicHost = new URL(hubConfig.publicUrl).host;
    if (opts.allowedHosts.length > 0 && !opts.allowedHosts.includes(publicHost)) {
      opts.allowedHosts.push(publicHost);
    }
  }

  if (!isLoopback(opts.host) && opts.token && opts.token.length < MIN_NETWORK_TOKEN_LENGTH) {
    throw new Error(
      `Refusing to bind ${opts.host} with a ${opts.token.length}-character token: use at least ` +
        `${MIN_NETWORK_TOKEN_LENGTH} random characters (e.g. \`openssl rand -base64 48\`).`,
    );
  }

  // Failed-auth lockout, keyed by the client address — or by a proxy header
  // such as CF-Connecting-IP when the socket address is always the proxy's.
  const authLimiter = new AuthLimiter();
  const clientIpHeader = process.env.EMAIL_MCP_HTTP_CLIENT_IP_HEADER?.trim().toLowerCase();
  const clientKey = (req: IncomingMessage): string => {
    const forwarded = clientIpHeader ? req.headers[clientIpHeader] : undefined;
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return value?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  };

  const server = buildServer(services);

  // This connection exists only so `server.server` can carry background-
  // service notifications — request handling below never uses `transport`:
  // the SDK's stateless transport is single-exchange (it throws "Stateless
  // transport cannot be reused across requests" on a second call), so one
  // shared instance can serve at most one HTTP request for the process's
  // entire lifetime. Each request gets its own server + transport instead.
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const background = startBackgroundServices(services, server.server);

  // DNS-rebinding protection. Default to loopback names plus the bind host; a
  // reverse-proxy deployment sets EMAIL_MCP_HTTP_ALLOWED_HOSTS to its public
  // domain (or `*` to disable this check when the proxy already enforces Host).
  const wildcard = opts.allowedHosts.includes('*');
  const hostAllowlist =
    opts.allowedHosts.length > 0
      ? opts.allowedHosts
      : [
          'localhost',
          '127.0.0.1',
          '[::1]',
          ...(isLoopback(opts.host) || opts.host === '0.0.0.0' ? [] : [opts.host]),
          ...(hub && process.env.EMAIL_MCP_HUB_PUBLIC_URL
            ? [new URL(process.env.EMAIL_MCP_HUB_PUBLIC_URL).host]
            : []),
        ];
  const validateHost = wildcard ? null : hostHeaderValidation(hostAllowlist);

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? opts.host}`);

      // Unauthenticated, unrestricted health probe (for load balancers).
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // Hub routes (admin UI, OAuth callback) authenticate with their own
      // session, not the MCP bearer token — but still sit behind the Host check.
      if (hub && url.pathname !== opts.path) {
        if (validateHost && !validateHost(req, res)) return;
        if (await hub.handle(req, res, url)) return;
      }

      if (url.pathname !== opts.path) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      // DNS-rebinding guard answers with 403 itself when it returns false.
      if (validateHost && !validateHost(req, res)) return;

      if (opts.token) {
        const client = clientKey(req);
        // Locked-out clients are refused before the token is even compared.
        const lockedFor = authLimiter.lockedFor(client);
        if (lockedFor > 0) {
          res.writeHead(429, {
            'content-type': 'application/json',
            'retry-after': String(lockedFor),
          });
          res.end(JSON.stringify({ error: 'too_many_failed_attempts' }));
          return;
        }
        if (!tokenMatches(req, opts.token)) {
          const outcome = authLimiter.recordFailure(client);
          if (outcome.kind === 'locked' && outcome.newlyLocked) {
            process.stderr.write(
              `[email-mcp] auth: locked out ${client} for ${outcome.retryAfterSec}s after repeated invalid tokens\n`,
            );
          }
          if (outcome.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
          }
          res.writeHead(outcome.kind === 'locked' ? 429 : 401, {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer',
            ...(outcome.kind === 'locked' ? { 'retry-after': String(outcome.retryAfterSec) } : {}),
          });
          res.end(
            JSON.stringify({
              error: outcome.kind === 'locked' ? 'too_many_failed_attempts' : 'unauthorized',
            }),
          );
          return;
        }
      }

      const reqServer = buildServer(services);
      const reqTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await reqServer.connect(reqTransport);
      await reqTransport.handleRequest(req, res);
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[email-mcp] http request error: ${message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });

  const shutdown = async (): Promise<void> => {
    await background.stop();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await services.connections.closeAll();
    await server.close();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => {
      const auth = opts.token ? 'bearer-token auth ON' : 'NO AUTH (loopback only)';
      const hostCheck = wildcard ? 'Host check OFF' : `Host allowlist: ${hostAllowlist.join(', ')}`;
      process.stderr.write(
        `email-mcp — Streamable HTTP on http://${opts.host}:${opts.port}${opts.path} — ${auth}; ${hostCheck}\n`,
      );
      resolve();
    });
  });
}
