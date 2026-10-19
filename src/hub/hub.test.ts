import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppServices } from '../app.js';
import ConnectionManager from '../connections/manager.js';
import type { AccountConfig } from '../types/index.js';
import { loadHubConfig } from './config.js';
import { deriveKeys, seal, signValue, unseal, verifyValue } from './crypto.js';
import Hub from './hub.js';
import HubAccountStore from './store.js';

const SECRET = 'x'.repeat(40);

function configAccount(name: string): AccountConfig {
  return {
    name,
    email: `${name}@example.com`,
    username: `${name}@example.com`,
    password: 'pw',
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: {
      host: 'smtp.example.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
      pool: { enabled: true, maxConnections: 1, maxMessages: 100 },
    },
  };
}

describe('hub crypto', () => {
  it('round-trips sealed data and rejects a wrong key', () => {
    const a = deriveKeys(SECRET);
    const b = deriveKeys('y'.repeat(40));
    const sealed = seal(a.encryption, 'refresh-token');
    expect(unseal(a.encryption, sealed)).toBe('refresh-token');
    expect(() => unseal(b.encryption, sealed)).toThrow();
  });

  it('derives distinct encryption and signing keys', () => {
    const keys = deriveKeys(SECRET);
    expect(keys.encryption.equals(keys.signing)).toBe(false);
  });

  it('rejects tampered signed values', () => {
    const { signing } = deriveKeys(SECRET);
    const signed = signValue(signing, { email: 'a@b.c' });
    expect(verifyValue(signing, signed)).toEqual({ email: 'a@b.c' });
    const forged = `${Buffer.from('{"email":"evil@x.y"}').toString('base64url')}.${signed.split('.')[1]}`;
    expect(verifyValue(signing, forged)).toBeUndefined();
    expect(verifyValue(signing, 'garbage')).toBeUndefined();
  });
});

describe('HubAccountStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-store-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persists encrypted and reloads', async () => {
    const file = path.join(dir, 'store.enc');
    const { encryption } = deriveKeys(SECRET);
    const store = new HubAccountStore(file, encryption);
    expect(await store.load()).toEqual([]);
    await store.upsert({
      name: 'work',
      email: 'me@corp.com',
      provider: 'google',
      refreshToken: 'secret-refresh',
      connectedAt: '2026-10-19T00:00:00Z',
      connectedBy: 'admin@corp.com',
    });
    const onDisk = await fs.readFile(file, 'utf8');
    expect(onDisk).not.toContain('secret-refresh');
    expect(onDisk).not.toContain('me@corp.com');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = new HubAccountStore(file, encryption);
    expect((await reloaded.load())[0]?.refreshToken).toBe('secret-refresh');
    await reloaded.remove('work');
    expect(await new HubAccountStore(file, encryption).load()).toEqual([]);
  });

  it('fails loudly with the wrong key', async () => {
    const file = path.join(dir, 'store.enc');
    await new HubAccountStore(file, deriveKeys(SECRET).encryption).upsert({
      name: 'a',
      email: 'a@b.c',
      provider: 'google',
      refreshToken: 't',
      connectedAt: '',
      connectedBy: '',
    });
    await expect(
      new HubAccountStore(file, deriveKeys('z'.repeat(40)).encryption).load(),
    ).rejects.toThrow(/EMAIL_MCP_HUB_SECRET_KEY/);
  });
});

describe('loadHubConfig', () => {
  it('lists every problem', () => {
    expect(() => loadHubConfig({ EMAIL_MCP_HUB_PUBLIC_URL: 'http://hub.example.com' })).toThrow(
      /https:\/\/[\s\S]*GOOGLE_CLIENT_ID[\s\S]*ADMIN_EMAILS[\s\S]*SECRET_KEY/,
    );
  });

  it('normalizes admins and trailing slash', () => {
    const cfg = loadHubConfig({
      EMAIL_MCP_HUB_PUBLIC_URL: 'https://hub.example.com/',
      EMAIL_MCP_HUB_GOOGLE_CLIENT_ID: 'id',
      EMAIL_MCP_HUB_GOOGLE_CLIENT_SECRET: 'secret',
      EMAIL_MCP_HUB_ADMIN_EMAILS: ' Admin@Example.com , other@example.com',
      EMAIL_MCP_HUB_SECRET_KEY: SECRET,
    });
    expect(cfg.publicUrl).toBe('https://hub.example.com');
    expect(cfg.adminEmails).toEqual(['admin@example.com', 'other@example.com']);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over a real HTTP server, with Google's endpoints faked.
// ---------------------------------------------------------------------------

interface Jar {
  [name: string]: string;
}

describe('Hub HTTP flow', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let hub: Hub;
  let services: AppServices;
  const realFetch = globalThis.fetch;
  let googleIdentity = 'admin@example.com';
  let grantedScope = 'openid email';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-http-'));
    const accounts = [configAccount('static')];
    services = {
      config: { accounts, settings: { server: { path: '/mcp' } } },
      connections: new ConnectionManager(accounts),
    } as unknown as AppServices;

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base);
      void hub.handle(req, res, url).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    hub = new Hub(
      {
        publicUrl: base,
        googleClientId: 'client-id',
        googleClientSecret: 'client-secret',
        adminEmails: ['admin@example.com'],
        secretKey: SECRET,
      },
      services,
      path.join(dir, 'store.enc'),
    );
    await hub.init();

    vi.spyOn(ConnectionManager, 'testImap').mockResolvedValue({ success: true });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('code_verifier')).toBeTruthy();
        expect(body.get('redirect_uri')).toBe(`${base}/oauth/callback`);
        return Response.json({
          access_token: 'access',
          refresh_token: grantedScope.includes('mail.google.com') ? 'refresh-1' : undefined,
          scope: grantedScope,
        });
      }
      if (url.startsWith('https://openidconnect.googleapis.com/')) {
        return Response.json({ email: googleIdentity, email_verified: true });
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
        return new Response('', { status: 200 });
      }
      return realFetch(input, init);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  function absorb(jar: Jar, res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      const pair = header.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      jar[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }

  function cookieHeader(jar: Jar): string {
    return Object.entries(jar)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async function get(jar: Jar, p: string): Promise<Response> {
    const res = await realFetch(`${base}${p}`, {
      redirect: 'manual',
      headers: { cookie: cookieHeader(jar) },
    });
    absorb(jar, res);
    return res;
  }

  async function post(jar: Jar, p: string, form: Record<string, string>): Promise<Response> {
    const res = await realFetch(`${base}${p}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: cookieHeader(jar),
        origin: base,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });
    absorb(jar, res);
    return res;
  }

  /** Follow Google's redirect back to our callback with a fake code. */
  async function completeGoogle(jar: Jar, authRes: Response): Promise<Response> {
    const location = new URL(authRes.headers.get('location') ?? '');
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    const state = location.searchParams.get('state') ?? '';
    return get(jar, `/oauth/callback?state=${encodeURIComponent(state)}&code=abc`);
  }

  async function signIn(jar: Jar): Promise<string> {
    googleIdentity = 'admin@example.com';
    grantedScope = 'openid email';
    const done = await completeGoogle(jar, await get(jar, '/admin/login'));
    expect(done.status).toBe(303);
    const page = await (await get(jar, '/admin')).text();
    expect(page).toContain('Connect a Google account');
    return /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
  }

  it('shows the sign-in page without a session', async () => {
    const res = await get({}, '/admin');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Sign in with Google');
  });

  it('rejects admins not on the allowlist', async () => {
    const jar: Jar = {};
    googleIdentity = 'intruder@example.com';
    const done = await completeGoogle(jar, await get(jar, '/admin/login'));
    expect(jar.emh_session ?? '').toBe('');
    const page = await (await get(jar, done.headers.get('location') ?? '/admin')).text();
    expect(page).toContain('not an allowed admin');
  });

  it('rejects a callback whose state was not started by this browser', async () => {
    const attacker: Jar = {};
    const authRes = await get(attacker, '/admin/login');
    const state = new URL(authRes.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const victim: Jar = {};
    const res = await get(victim, `/oauth/callback?state=${state}&code=abc`);
    expect(victim.emh_session ?? '').toBe('');
    expect(await (await get(victim, res.headers.get('location') ?? '')).text()).toContain(
      'expired or was started elsewhere',
    );
  });

  it('connects, persists, tests and removes a mailbox', async () => {
    const jar: Jar = {};
    const csrf = await signIn(jar);

    // CSRF and origin checks
    expect((await post(jar, '/admin/connect', { csrf: 'nope' })).headers.get('location')).toMatch(
      /\/admin\?n=/,
    );
    const crossSite = await realFetch(`${base}/admin/connect`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: cookieHeader(jar), origin: 'https://evil.example' },
      body: new URLSearchParams({ csrf }).toString(),
    });
    expect(crossSite.status).toBe(403);

    // Connect
    googleIdentity = 'me@corp.com';
    grantedScope = 'openid email https://mail.google.com/';
    const start = await post(jar, '/admin/connect', {
      csrf,
      name: 'work',
      login_hint: 'me@corp.com',
    });
    const loc = new URL(start.headers.get('location') ?? '');
    expect(loc.searchParams.get('access_type')).toBe('offline');
    expect(loc.searchParams.get('scope')).toContain('https://mail.google.com/');
    expect(loc.searchParams.get('login_hint')).toBe('me@corp.com');
    const done = await completeGoogle(jar, start);
    const page = await (await get(jar, done.headers.get('location') ?? '')).text();
    expect(page).toContain('Connected me@corp.com as &quot;work&quot;');

    // Live registration
    expect(services.connections.getAccountNames()).toEqual(['static', 'work']);
    const account = services.connections.getAccount('work');
    expect(account.oauth2?.refreshToken).toBe('refresh-1');
    expect(account.imap.host).toBe('imap.gmail.com');
    expect(services.config.accounts.map((a) => a.name)).toEqual(['static', 'work']);

    // Survives restart
    const accounts = [configAccount('static')];
    const restarted = {
      config: { accounts, settings: { server: { path: '/mcp' } } },
      connections: new ConnectionManager(accounts),
    } as unknown as AppServices;
    await new Hub(
      {
        publicUrl: base,
        googleClientId: 'client-id',
        googleClientSecret: 'client-secret',
        adminEmails: ['admin@example.com'],
        secretKey: SECRET,
      },
      restarted,
      path.join(dir, 'store.enc'),
    ).init();
    expect(restarted.connections.getAccountNames()).toEqual(['static', 'work']);

    // Config-file accounts cannot be removed through the hub
    const blocked = await post(jar, '/admin/accounts/remove', { csrf, name: 'static' });
    expect(await (await get(jar, blocked.headers.get('location') ?? '')).text()).toContain(
      'not a hub-connected account',
    );

    // Remove
    const removed = await post(jar, '/admin/accounts/remove', { csrf, name: 'work' });
    expect(await (await get(jar, removed.headers.get('location') ?? '')).text()).toContain(
      'revoked its Google token',
    );
    expect(services.connections.getAccountNames()).toEqual(['static']);
  });

  it('refuses a connect where Gmail access was not granted', async () => {
    const jar: Jar = {};
    const csrf = await signIn(jar);
    googleIdentity = 'me@corp.com';
    grantedScope = 'openid email';
    const done = await completeGoogle(jar, await post(jar, '/admin/connect', { csrf }));
    expect(await (await get(jar, done.headers.get('location') ?? '')).text()).toContain(
      'Gmail access was not granted',
    );
    expect(services.connections.getAccountNames()).toEqual(['static']);
  });

  it('forged flash notices are ignored', async () => {
    const forged = Buffer.from(JSON.stringify({ kind: 'ok', text: '<script>x</script>' })).toString(
      'base64url',
    );
    const page = await (await get({}, `/admin?n=${forged}.bad`)).text();
    expect(page).not.toContain('<script>');
  });
});
