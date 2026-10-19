import { createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../config/loader.js';
import OAuthService from './oauth.service.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const KEY_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'hub@project.iam.gserviceaccount.com',
  private_key: PRIVATE_PEM,
  token_uri: 'https://oauth2.googleapis.com/token',
});

function toml(keyFile: string): string {
  return `
[[accounts]]
name = "main"
email = "me@corp.example"

[accounts.google_service_account]
key_file = "${keyFile}"

[accounts.imap]
host = "imap.gmail.com"

[accounts.smtp]
host = "smtp.gmail.com"
`;
}

describe('Google service account (domain-wide delegation)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loads the key and impersonates the account address', async () => {
    const keyFile = path.join(dir, 'key.json');
    await fs.writeFile(keyFile, KEY_JSON);
    const configPath = path.join(dir, 'config.toml');
    await fs.writeFile(configPath, toml(keyFile));

    const config = await loadConfig(configPath);
    const oauth2 = config.accounts[0]?.oauth2;
    expect(oauth2?.provider).toBe('google-service-account');
    expect(oauth2?.serviceAccount?.clientEmail).toBe('hub@project.iam.gserviceaccount.com');
    expect(oauth2?.serviceAccount?.subject).toBe('me@corp.example');
  });

  it('fails at load time for a missing or wrong key file', async () => {
    const configPath = path.join(dir, 'config.toml');
    await fs.writeFile(configPath, toml(path.join(dir, 'missing.json')));
    await expect(loadConfig(configPath)).rejects.toThrow(
      'Could not read Google service account key',
    );

    const notSa = path.join(dir, 'other.json');
    await fs.writeFile(notSa, JSON.stringify({ type: 'authorized_user' }));
    await fs.writeFile(configPath, toml(notSa));
    await expect(loadConfig(configPath)).rejects.toThrow(
      'is not a Google service account JSON key',
    );
  });

  it('mints a token with a correctly signed JWT assertion', async () => {
    const keyFile = path.join(dir, 'key.json');
    await fs.writeFile(keyFile, KEY_JSON);
    const configPath = path.join(dir, 'config.toml');
    await fs.writeFile(configPath, toml(keyFile));
    const oauth2 = (await loadConfig(configPath)).accounts[0]?.oauth2;
    if (!oauth2) throw new Error('no oauth2');

    let assertion = '';
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(String(init.body));
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      assertion = body.get('assertion') ?? '';
      return { ok: true, json: async () => ({ access_token: 'sa-token', expires_in: 3600 }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const svc = new OAuthService();
    expect(await svc.getAccessToken(oauth2)).toBe('sa-token');
    // cached on the second call
    expect(await svc.getAccessToken(oauth2)).toBe('sa-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [header, claims, signature] = assertion.split('.');
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
    expect(valid).toBe(true);
    const payload = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      iss: 'hub@project.iam.gserviceaccount.com',
      sub: 'me@corp.example',
      scope: 'https://mail.google.com/',
      aud: 'https://oauth2.googleapis.com/token',
    });
  });

  it('surfaces a delegation failure with the subject', async () => {
    const keyFile = path.join(dir, 'key.json');
    await fs.writeFile(keyFile, KEY_JSON);
    const configPath = path.join(dir, 'config.toml');
    await fs.writeFile(configPath, toml(keyFile));
    const oauth2 = (await loadConfig(configPath)).accounts[0]?.oauth2;
    if (!oauth2) throw new Error('no oauth2');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => '{"error":"unauthorized_client"}',
      }),
    );
    await expect(new OAuthService().getAccessToken(oauth2)).rejects.toThrow(
      /me@corp\.example failed \(401\).*unauthorized_client/,
    );
  });
});
