/**
 * Google OAuth 2.0 web-server flow with PKCE, used by the hub for both admin
 * sign-in (openid email) and mailbox connection (+ https://mail.google.com/).
 */

import { createHash } from 'node:crypto';

import { randomToken } from './crypto.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const SIGN_IN_SCOPES = ['openid', 'email'];
export const MAILBOX_SCOPES = ['openid', 'email', 'https://mail.google.com/'];

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  /** Request a refresh token (mailbox connect). */
  offline: boolean;
  loginHint?: string;
}

export function buildAuthUrl(o: AuthUrlOptions): string {
  const params = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: o.scopes.join(' '),
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: 'S256',
    // consent forces Google to issue a refresh token even on reconnect.
    prompt: o.offline ? 'consent select_account' : 'select_account',
  });
  if (o.offline) params.set('access_type', 'offline');
  if (o.loginHint) params.set('login_hint', o.loginHint);
  return `${AUTH_URL}?${params.toString()}`;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  scope: string;
}

export async function exchangeCode(o: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: o.clientId,
      client_secret: o.clientSecret,
      redirect_uri: o.redirectUri,
      code: o.code,
      code_verifier: o.codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    // Google's error body names the problem (invalid_grant, redirect_uri_mismatch)
    // and never echoes tokens, so it is safe to surface.
    throw new Error(`Google token exchange failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    scope?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope ?? '',
  };
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
}

export async function fetchIdentity(accessToken: string): Promise<GoogleIdentity> {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google userinfo failed (${response.status})`);
  }
  const data = (await response.json()) as { email?: string; email_verified?: boolean };
  if (!data.email) throw new Error('Google did not return an email address (missing email scope?)');
  return { email: data.email.toLowerCase(), emailVerified: data.email_verified === true };
}

/** Best-effort revocation; returns false instead of throwing. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
