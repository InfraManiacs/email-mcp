/**
 * Hub crypto primitives: AES-256-GCM for the token store and HMAC-SHA256 for
 * signed values (session cookies, CSRF tokens). Both keys are derived from
 * the one EMAIL_MCP_HUB_SECRET_KEY with HKDF so they never coincide.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export interface HubKeys {
  encryption: Buffer;
  signing: Buffer;
}

export function deriveKeys(secret: string): HubKeys {
  const ikm = Buffer.from(secret, 'utf8');
  const salt = Buffer.from('email-mcp-hub', 'utf8');
  return {
    encryption: Buffer.from(hkdfSync('sha256', ikm, salt, 'token-store-v1', 32)),
    signing: Buffer.from(hkdfSync('sha256', ikm, salt, 'signing-v1', 32)),
  };
}

export interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** Throws if the key is wrong or the payload was tampered with. */
export function unseal(key: Buffer, sealed: Sealed): string {
  if (sealed.v !== 1) throw new Error(`Unsupported sealed payload version: ${String(sealed.v)}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function mac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

/** `<base64url(json)>.<mac>` */
export function signValue(key: Buffer, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(key, body)}`;
}

/** Returns the payload, or undefined when the signature does not verify. */
export function verifyValue<T>(key: Buffer, signed: string | undefined): T | undefined {
  if (!signed) return undefined;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(mac(key, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
