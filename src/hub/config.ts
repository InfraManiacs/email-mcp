/**
 * Hub mode configuration, read from EMAIL_MCP_HUB_* environment variables.
 *
 * Hub mode turns the Streamable HTTP server into a self-service mailbox hub:
 * an admin UI (behind Google sign-in) where Google accounts are connected via
 * a hosted OAuth flow, with refresh tokens persisted encrypted under the
 * state directory. It is off unless EMAIL_MCP_HUB_PUBLIC_URL is set.
 */

export interface HubConfig {
  /** External base URL, e.g. https://mail-hub.example.com (no trailing slash). */
  publicUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Lower-cased Google account emails allowed into the admin UI. */
  adminEmails: string[];
  /** Root secret for token encryption and session signing. */
  secretKey: string;
}

const MIN_SECRET_LENGTH = 32;

export function isHubEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.EMAIL_MCP_HUB_PUBLIC_URL);
}

/** Parse hub config; throws listing every missing/invalid variable. */
export function loadHubConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is not set`);
    return value ?? '';
  };

  const publicUrl = need('EMAIL_MCP_HUB_PUBLIC_URL').replace(/\/+$/, '');
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (url.protocol !== 'https:' && !local) {
        problems.push('EMAIL_MCP_HUB_PUBLIC_URL must be https:// (session cookies are Secure)');
      }
    } catch {
      problems.push(`EMAIL_MCP_HUB_PUBLIC_URL is not a valid URL: ${publicUrl}`);
    }
  }

  const googleClientId = need('EMAIL_MCP_HUB_GOOGLE_CLIENT_ID');
  const googleClientSecret = need('EMAIL_MCP_HUB_GOOGLE_CLIENT_SECRET');
  const adminEmails = need('EMAIL_MCP_HUB_ADMIN_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const secretKey = need('EMAIL_MCP_HUB_SECRET_KEY');
  if (secretKey && secretKey.length < MIN_SECRET_LENGTH) {
    problems.push(`EMAIL_MCP_HUB_SECRET_KEY must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  if (problems.length > 0) {
    throw new Error(`Hub mode is enabled but misconfigured:\n  - ${problems.join('\n  - ')}`);
  }
  return { publicUrl, googleClientId, googleClientSecret, adminEmails, secretKey };
}
