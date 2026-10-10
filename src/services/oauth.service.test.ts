import type { OAuth2Config } from '../types/index.js';
import OAuthService from './oauth.service.js';

function expiredConfig(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
  return {
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    ...overrides,
  } as OAuth2Config;
}

/** A token endpoint that resolves only when released, so calls can overlap. */
function deferredTokenEndpoint(accessToken = 'fresh-token') {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.fn().mockImplementation(async () => {
    await gate;
    return {
      ok: true,
      json: async () => ({ access_token: accessToken, expires_in: 3600 }),
    };
  });
  return { fetchMock, release: () => release?.() };
}

describe('OAuthService.getAccessToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the cached token without contacting the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = new OAuthService();
    const config = expiredConfig({
      accessToken: 'still-good',
      tokenExpiry: Date.now() + 60 * 60 * 1000,
    } as Partial<OAuth2Config>);

    await expect(svc.getAccessToken(config)).resolves.toBe('still-good');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes once when several callers race an expired token', async () => {
    // One account is shared by the IMAP client, the SMTP transport, their two
    // connection tests and the IDLE watcher. Without dedup each starts its own
    // refresh; providers that rotate the refresh token on use then invalidate
    // the losers, which locks the account out rather than wasting a request.
    const { fetchMock, release } = deferredTokenEndpoint('shared-token');
    vi.stubGlobal('fetch', fetchMock);
    const svc = new OAuthService();
    const config = expiredConfig();

    const callers = [
      svc.getAccessToken(config),
      svc.getAccessToken(config),
      svc.getAccessToken(config),
      svc.getAccessToken(config),
      svc.getAccessToken(config),
    ];
    release();
    const tokens = await Promise.all(callers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(Array(5).fill('shared-token'));
  });

  it('caches onto the shared config so later callers skip the network', async () => {
    const { fetchMock, release } = deferredTokenEndpoint('cached-token');
    vi.stubGlobal('fetch', fetchMock);
    const svc = new OAuthService();
    const config = expiredConfig();

    const first = svc.getAccessToken(config);
    release();
    await first;

    await expect(svc.getAccessToken(config)).resolves.toBe('cached-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(config.accessToken).toBe('cached-token');
  });

  it('does not pin a failed refresh, so a later attempt can succeed', async () => {
    let attempt = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, status: 429, text: async () => 'rate limited' };
      }
      return { ok: true, json: async () => ({ access_token: 'second-try', expires_in: 3600 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = new OAuthService();
    const config = expiredConfig();

    await expect(svc.getAccessToken(config)).rejects.toThrow(/429/);
    // A rejected promise left in the map would fail every later call.
    await expect(svc.getAccessToken(config)).resolves.toBe('second-try');
  });
});
