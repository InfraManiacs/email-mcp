/**
 * OAuth2 token management service.
 *
 * Handles token refresh and caching for Google and Microsoft OAuth2/XOAUTH2.
 * Uses native fetch (Node 22+) — no external HTTP dependencies.
 */

import { createSign } from 'node:crypto';

import type { OAuth2Config } from '../types/index.js';

// ---------------------------------------------------------------------------
// Provider endpoint configs
// ---------------------------------------------------------------------------

interface ProviderEndpoints {
  tokenUrl: string;
  authUrl: string;
  scopes: string[];
}

const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoints> = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['https://mail.google.com/'],
  },
  microsoft: {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
    ],
  },
};

/** 5-minute safety buffer before token expiry */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export default class OAuthService {
  /**
   * Refreshes already in progress, keyed by the config object they belong to.
   *
   * Several callers share one account: the IMAP client, the SMTP transport,
   * their two connection tests, and the IDLE watcher. When a token expires
   * they can arrive together and each start its own refresh. That is not
   * merely a wasted request — providers that rotate the refresh token on use
   * invalidate the loser's copy, and Microsoft rate-limits refreshes, so the
   * account can end up unable to authenticate at all. Concurrent callers get
   * the same in-flight promise instead, as ImapService does for its label
   * strategy. Keyed weakly so a dropped account config is not retained.
   */
  private pendingRefreshes = new WeakMap<OAuth2Config, Promise<string>>();

  /**
   * Get a valid access token, refreshing if expired.
   */
  async getAccessToken(oauth2: OAuth2Config): Promise<string> {
    if (!OAuthService.isTokenExpired(oauth2) && oauth2.accessToken) {
      return oauth2.accessToken;
    }

    const inFlight = this.pendingRefreshes.get(oauth2);
    if (inFlight) return inFlight;

    const refresh = (async () => {
      const result = await OAuthService.refreshAccessToken(oauth2);

      // Cache on the config object (in-memory only). Callers share the object,
      // so one refresh serves every holder of this account.
      Object.assign(oauth2, {
        accessToken: result.accessToken,
        tokenExpiry: Date.now() + result.expiresIn * 1000,
      });

      return result.accessToken;
    })();

    this.pendingRefreshes.set(oauth2, refresh);
    try {
      return await refresh;
    } finally {
      // Cleared on failure too, so a transient refresh error does not pin a
      // rejected promise and fail every later attempt.
      this.pendingRefreshes.delete(oauth2);
    }
  }

  /**
   * Check if the cached access token is expired or missing.
   */
  static isTokenExpired(oauth2: OAuth2Config): boolean {
    if (!oauth2.accessToken || !oauth2.tokenExpiry) return true;
    return Date.now() >= oauth2.tokenExpiry - TOKEN_EXPIRY_BUFFER_MS;
  }

  /**
   * Exchange refresh token for a new access token.
   */
  static async refreshAccessToken(
    oauth2: OAuth2Config,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    if (oauth2.provider === 'google-service-account') {
      return OAuthService.mintServiceAccountToken(oauth2);
    }
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      refresh_token: oauth2.refreshToken,
    });

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 token refresh failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Domain-wide delegation: sign a JWT as the service account with the
   * mailbox address as `sub`, and trade it for an access token. There is no
   * refresh token — a new assertion is signed each time.
   */
  static async mintServiceAccountToken(
    oauth2: OAuth2Config,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const sa = oauth2.serviceAccount;
    if (!sa) throw new Error('Google service account key was not loaded');
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: sa.clientEmail,
      sub: sa.subject,
      scope: (oauth2.scopes ?? ['https://mail.google.com/']).join(' '),
      aud: sa.tokenUri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.privateKey, 'base64url');

    const response = await fetch(sa.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
    });
    if (!response.ok) {
      const text = await response.text();
      // unauthorized_client here almost always means the client ID / scope is
      // not authorized under Domain-wide delegation in the Admin console.
      throw new Error(
        `Service account token request for ${sa.subject} failed (${response.status}): ${text}`,
      );
    }
    const data = (await response.json()) as { access_token: string; expires_in: number };
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  }

  /**
   * Get provider endpoints for token exchange and authorization.
   */
  static getProviderEndpoints(oauth2: OAuth2Config): ProviderEndpoints {
    if (oauth2.provider === 'custom') {
      if (!oauth2.tokenUrl || !oauth2.authUrl) {
        throw new Error('Custom OAuth2 provider requires tokenUrl and authUrl');
      }
      return {
        tokenUrl: oauth2.tokenUrl,
        authUrl: oauth2.authUrl,
        scopes: oauth2.scopes ?? [],
      };
    }

    const endpoints = PROVIDER_ENDPOINTS[oauth2.provider];
    if (!endpoints) {
      throw new Error(`Unknown OAuth2 provider: ${oauth2.provider}`);
    }
    return endpoints;
  }

  /**
   * Generate an OAuth2 authorization URL for the CLI setup wizard.
   */
  static generateAuthUrl(oauth2: OAuth2Config, redirectUri: string): string {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);
    const params = new URLSearchParams({
      client_id: oauth2.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: endpoints.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${endpoints.authUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens (initial setup).
   */
  static async exchangeCode(
    oauth2: OAuth2Config,
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 code exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }
}
