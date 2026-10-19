/**
 * Mailbox hub: admin UI + hosted Google OAuth flow on top of the Streamable
 * HTTP server.
 *
 * Routes (all under the public URL):
 *   GET  /admin                  dashboard, or sign-in page without a session
 *   GET  /admin/login            start admin sign-in (openid email)
 *   POST /admin/logout
 *   POST /admin/connect          start mailbox connect (+ mail.google.com scope)
 *   POST /admin/accounts/test    IMAP + SMTP login check
 *   POST /admin/accounts/remove  revoke at Google, forget, disconnect
 *   GET  /oauth/callback         redirect target for both flows
 *
 * Admin identity is a Google account on the EMAIL_MCP_HUB_ADMIN_EMAILS
 * allowlist, re-checked on every request. Sessions are HMAC-signed cookies;
 * POSTs carry a CSRF token bound to the session and must come from our own
 * origin. OAuth `state` is single-use, expires after 10 minutes and is bound
 * to the initiating browser by a cookie.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import type { AppServices } from '../app.js';
import { normalizeAccount } from '../config/loader.js';
import { AccountConfigSchema } from '../config/schema.js';
import { xdg } from '../config/xdg.js';
import ConnectionManager from '../connections/manager.js';
import { mcpLog } from '../logging.js';
import OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import type { HubConfig } from './config.js';
import { deriveKeys, type HubKeys, randomToken, signValue, verifyValue } from './crypto.js';
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  fetchIdentity,
  MAILBOX_SCOPES,
  revokeToken,
  SIGN_IN_SCOPES,
} from './google.js';
import HubAccountStore, { type HubAccountRecord } from './store.js';
import { type AccountRow, type NoticeView, renderDashboard, renderLogin } from './ui.js';

const HUB_STORE_FILE = path.join(xdg.state, 'hub-accounts.json.enc');

const SESSION_COOKIE = 'emh_session';
const STATE_COOKIE = 'emh_oauth';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_FORM_BYTES = 16 * 1024;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

interface Session {
  email: string;
  exp: number;
}

interface PendingAuth {
  purpose: 'login' | 'connect';
  verifier: string;
  expires: number;
  /** connect only */
  accountName?: string;
  adminEmail?: string;
}

type Notice = NoticeView;

export default class Hub {
  private readonly keys: HubKeys;

  private readonly store: HubAccountStore;

  private readonly pending = new Map<string, PendingAuth>();

  private readonly oauthService = new OAuthService();

  private readonly redirectUri: string;

  private readonly secureCookies: boolean;

  /** Accounts from config.toml, captured before any hub account is added. */
  private readonly configNames: Set<string>;

  constructor(
    private readonly cfg: HubConfig,
    private readonly services: AppServices,
    storeFile: string = HUB_STORE_FILE,
  ) {
    this.keys = deriveKeys(cfg.secretKey);
    this.store = new HubAccountStore(storeFile, this.keys.encryption);
    this.redirectUri = `${cfg.publicUrl}/oauth/callback`;
    this.secureCookies = cfg.publicUrl.startsWith('https://');
    this.configNames = new Set(services.config.accounts.map((a) => a.name));
  }

  /** Load persisted accounts and register them with the running services. */
  async init(): Promise<void> {
    const records = await this.store.load();
    for (const record of records) {
      if (this.isConfigAccount(record.name)) {
        await mcpLog(
          'warning',
          'hub',
          `Hub account "${record.name}" is shadowed by a config-file account of the same name; skipping`,
        );
        continue;
      }
      await this.register(record);
    }
    await mcpLog(
      'info',
      'hub',
      `Hub enabled at ${this.cfg.publicUrl}/admin — ${records.length} connected account(s), ` +
        `admins: ${this.cfg.adminEmails.join(', ')}`,
    );
  }

  /** True when the request was a hub route and has been answered. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method ?? 'GET'} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    switch (route) {
      case 'GET /admin':
        await this.showAdmin(req, res, url);
        return true;
      case 'GET /admin/login':
        this.startAuth(res, { purpose: 'login' });
        return true;
      case 'GET /oauth/callback':
        await this.callback(req, res, url);
        return true;
      case 'POST /admin/logout':
      case 'POST /admin/connect':
      case 'POST /admin/accounts/test':
      case 'POST /admin/accounts/remove':
        await this.post(route, req, res);
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  private async showAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const notice = this.readNotice(url);
    const session = this.session(req);
    if (!session) {
      sendHtml(res, 200, renderLogin(notice));
      return;
    }
    const hubRecords = new Map(this.store.list().map((r) => [r.name, r]));
    const accounts: AccountRow[] = this.services.config.accounts.map((a) => {
      const record = hubRecords.get(a.name);
      return record && !this.isConfigAccount(a.name)
        ? {
            name: a.name,
            email: a.email,
            source: 'hub',
            connectedAt: record.connectedAt,
            connectedBy: record.connectedBy,
          }
        : { name: a.name, email: a.email, source: 'config' };
    });
    sendHtml(
      res,
      200,
      renderDashboard({
        adminEmail: session.email,
        csrf: this.csrfFor(req),
        accounts,
        mcpUrl: `${this.cfg.publicUrl}${this.services.config.settings.server.path ?? '/mcp'}`,
        notice,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  private startAuth(
    res: ServerResponse,
    o: {
      purpose: 'login' | 'connect';
      accountName?: string;
      adminEmail?: string;
      loginHint?: string;
    },
  ): void {
    this.prunePending();
    const state = randomToken();
    const pkce = createPkce();
    this.pending.set(state, {
      purpose: o.purpose,
      verifier: pkce.verifier,
      expires: Date.now() + STATE_TTL_MS,
      accountName: o.accountName,
      adminEmail: o.adminEmail,
    });
    const location = buildAuthUrl({
      clientId: this.cfg.googleClientId,
      redirectUri: this.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      scopes: o.purpose === 'login' ? SIGN_IN_SCOPES : MAILBOX_SCOPES,
      offline: o.purpose === 'connect',
      loginHint: o.loginHint,
    });
    res.writeHead(302, {
      location,
      'set-cookie': this.cookie(
        STATE_COOKIE,
        signValue(this.keys.signing, state),
        STATE_TTL_MS,
        '/oauth',
      ),
      'cache-control': 'no-store',
    });
    res.end();
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get('state') ?? '';
    const pending = this.pending.get(state);
    this.pending.delete(state);
    const boundState = verifyValue<string>(this.keys.signing, readCookie(req, STATE_COOKIE));
    const clearState = this.cookie(STATE_COOKIE, '', 0, '/oauth');

    if (!pending || pending.expires < Date.now() || boundState !== state) {
      this.redirect(
        res,
        { kind: 'error', text: 'Sign-in expired or was started elsewhere. Try again.' },
        [clearState],
      );
      return;
    }
    const googleError = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (googleError || !code) {
      this.redirect(
        res,
        { kind: 'error', text: `Google returned: ${googleError ?? 'no authorization code'}` },
        [clearState],
      );
      return;
    }

    try {
      const tokens = await exchangeCode({
        clientId: this.cfg.googleClientId,
        clientSecret: this.cfg.googleClientSecret,
        redirectUri: this.redirectUri,
        code,
        codeVerifier: pending.verifier,
      });
      const identity = await fetchIdentity(tokens.accessToken);
      if (!identity.emailVerified)
        throw new Error(`${identity.email} is not a verified Google address`);

      if (pending.purpose === 'login') {
        if (!this.cfg.adminEmails.includes(identity.email)) {
          await mcpLog('warning', 'hub', `Rejected admin sign-in from ${identity.email}`);
          this.redirect(
            res,
            { kind: 'error', text: `${identity.email} is not an allowed admin.` },
            [clearState],
          );
          return;
        }
        const session = signValue(this.keys.signing, {
          email: identity.email,
          exp: Date.now() + SESSION_TTL_MS,
        } satisfies Session);
        await mcpLog('info', 'hub', `Admin signed in: ${identity.email}`);
        this.redirect(res, undefined, [
          clearState,
          this.cookie(SESSION_COOKIE, session, SESSION_TTL_MS, '/'),
        ]);
        return;
      }

      // connect: the initiating admin must still hold a valid session.
      const session = this.session(req);
      if (!session || session.email !== pending.adminEmail) {
        this.redirect(
          res,
          { kind: 'error', text: 'Admin session ended during connect. Sign in again.' },
          [clearState],
        );
        return;
      }
      if (!tokens.scope.split(' ').includes('https://mail.google.com/')) {
        throw new Error(
          'Gmail access was not granted (the mail permission checkbox was left unticked)',
        );
      }
      if (!tokens.refreshToken) {
        throw new Error(
          'Google did not issue a refresh token — remove the app from the account and retry',
        );
      }
      const name = this.resolveAccountName(pending.accountName, identity.email);
      const record: HubAccountRecord = {
        name,
        email: identity.email,
        provider: 'google',
        refreshToken: tokens.refreshToken,
        connectedAt: new Date().toISOString(),
        connectedBy: session.email,
      };
      await this.store.upsert(record);
      const account = await this.register(record);
      const imap = await ConnectionManager.testImap(account, this.oauthService);
      await mcpLog('info', 'hub', `Connected ${identity.email} as "${name}" (by ${session.email})`);
      this.redirect(
        res,
        imap.success
          ? { kind: 'ok', text: `Connected ${identity.email} as "${name}".` }
          : {
              kind: 'error',
              text: `Saved ${identity.email} as "${name}", but the IMAP login failed: ${imap.error ?? 'unknown error'}`,
            },
        [clearState],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'hub', `OAuth callback failed: ${message}`);
      this.redirect(res, { kind: 'error', text: message }, [clearState]);
    }
  }

  // -------------------------------------------------------------------------
  // Form posts
  // -------------------------------------------------------------------------

  private async post(route: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.session(req);
    if (!session || !this.sameOrigin(req)) {
      sendHtml(res, 403, renderLogin({ kind: 'error', text: 'Not signed in.' }));
      return;
    }
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      sendHtml(res, 413, renderLogin({ kind: 'error', text: 'Request too large.' }));
      return;
    }
    if (!safeEqual(form.get('csrf') ?? '', this.csrfFor(req))) {
      this.redirect(res, { kind: 'error', text: 'Form expired — reload and try again.' });
      return;
    }

    const name = (form.get('name') ?? '').trim();
    switch (route) {
      case 'POST /admin/logout':
        this.redirect(res, undefined, [this.cookie(SESSION_COOKIE, '', 0, '/')]);
        return;

      case 'POST /admin/connect': {
        if (name && !ACCOUNT_NAME.test(name)) {
          this.redirect(res, {
            kind: 'error',
            text: 'Account names use letters, digits, ".", "_" and "-".',
          });
          return;
        }
        if (name && this.isConfigAccount(name)) {
          this.redirect(res, {
            kind: 'error',
            text: `"${name}" is a config-file account; pick another name.`,
          });
          return;
        }
        const loginHint = (form.get('login_hint') ?? '').trim() || undefined;
        this.startAuth(res, {
          purpose: 'connect',
          accountName: name || undefined,
          adminEmail: session.email,
          loginHint,
        });
        return;
      }

      case 'POST /admin/accounts/test': {
        let account: AccountConfig;
        try {
          account = this.services.connections.getAccount(name);
        } catch {
          this.redirect(res, { kind: 'error', text: `Unknown account "${name}".` });
          return;
        }
        const [imap, smtp] = await Promise.all([
          ConnectionManager.testImap(account, this.oauthService),
          ConnectionManager.testSmtp(account, this.oauthService),
        ]);
        const failures = [
          imap.success ? '' : `IMAP: ${imap.error ?? 'failed'}`,
          smtp.success ? '' : `SMTP: ${smtp.error ?? 'failed'}`,
        ].filter(Boolean);
        this.redirect(
          res,
          failures.length === 0
            ? { kind: 'ok', text: `"${name}": IMAP and SMTP login OK.` }
            : { kind: 'error', text: `"${name}": ${failures.join(' · ')}` },
        );
        return;
      }

      case 'POST /admin/accounts/remove': {
        const removed = await this.store.remove(name);
        if (!removed) {
          this.redirect(res, { kind: 'error', text: `"${name}" is not a hub-connected account.` });
          return;
        }
        await this.unregister(name);
        const revoked = await revokeToken(removed.refreshToken);
        await mcpLog('info', 'hub', `Removed "${name}" (${removed.email}) by ${session.email}`);
        this.redirect(res, {
          kind: 'ok',
          text: `Removed "${name}"${revoked ? ' and revoked its Google token' : ' (token revocation failed — revoke it at myaccount.google.com)'}.`,
        });
        return;
      }

      default:
        sendHtml(res, 404, renderLogin());
    }
  }

  // -------------------------------------------------------------------------
  // Account registration
  // -------------------------------------------------------------------------

  private async register(record: HubAccountRecord): Promise<AccountConfig> {
    const raw = AccountConfigSchema.parse({
      name: record.name,
      email: record.email,
      oauth2: {
        provider: 'google',
        client_id: this.cfg.googleClientId,
        client_secret: this.cfg.googleClientSecret,
        refresh_token: record.refreshToken,
      },
      imap: { host: 'imap.gmail.com', port: 993, tls: true },
      smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
    });
    const account = normalizeAccount(raw);
    await this.services.connections.addAccount(account);
    const accounts = this.services.config.accounts;
    const index = accounts.findIndex((a) => a.name === account.name);
    if (index >= 0) accounts[index] = account;
    else accounts.push(account);
    return account;
  }

  private async unregister(name: string): Promise<void> {
    await this.services.connections.removeAccount(name);
    const accounts = this.services.config.accounts;
    const index = accounts.findIndex((a) => a.name === name);
    if (index >= 0) accounts.splice(index, 1);
  }

  private isConfigAccount(name: string): boolean {
    return this.configNames.has(name);
  }

  /** Explicit name, else the existing hub name for this address, else a slug of it. */
  private resolveAccountName(requested: string | undefined, email: string): string {
    if (requested) return requested;
    const existing = this.store.list().find((r) => r.email === email);
    if (existing) return existing.name;
    const slug = email
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);
    return this.isConfigAccount(slug) ? `${slug}-hub` : slug;
  }

  // -------------------------------------------------------------------------
  // Sessions, CSRF, cookies
  // -------------------------------------------------------------------------

  private session(req: IncomingMessage): Session | undefined {
    const session = verifyValue<Session>(this.keys.signing, readCookie(req, SESSION_COOKIE));
    if (!session || session.exp < Date.now()) return undefined;
    // Re-checked every request so removing an admin takes effect immediately.
    return this.cfg.adminEmails.includes(session.email) ? session : undefined;
  }

  private csrfFor(req: IncomingMessage): string {
    return createHmac('sha256', this.keys.signing)
      .update(`csrf:${readCookie(req, SESSION_COOKIE) ?? ''}`)
      .digest('base64url');
  }

  /** Reject cross-site POSTs: Origin (or Referer) must be our public origin. */
  private sameOrigin(req: IncomingMessage): boolean {
    const expected = new URL(this.cfg.publicUrl).origin;
    const origin = req.headers.origin;
    if (origin) return origin === expected;
    const referer = req.headers.referer;
    if (!referer) return false;
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }

  private cookie(name: string, value: string, maxAgeMs: number, cookiePath: string): string {
    return [
      `${name}=${value}`,
      `Path=${cookiePath}`,
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      'HttpOnly',
      'SameSite=Lax',
      ...(this.secureCookies ? ['Secure'] : []),
    ].join('; ');
  }

  /** Flash notices travel signed in the query string. */
  private redirect(res: ServerResponse, notice?: Notice, cookies: string[] = []): void {
    const location = notice
      ? `/admin?n=${encodeURIComponent(signValue(this.keys.signing, notice))}`
      : '/admin';
    res.writeHead(303, { location, 'cache-control': 'no-store', 'set-cookie': cookies });
    res.end();
  }

  private readNotice(url: URL): Notice | undefined {
    return verifyValue<Notice>(this.keys.signing, url.searchParams.get('n') ?? undefined);
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [state, entry] of this.pending) {
      if (entry.expires < now) this.pending.delete(state);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(html);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new Error('form too large');
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
