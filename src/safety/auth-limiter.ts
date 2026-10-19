/**
 * Failed-authentication throttling for the HTTP transport.
 *
 * A client that keeps presenting bad bearer tokens is locked out — its
 * requests are refused with 429 *before* the token is compared — for
 * `lockoutMs` once it reaches `maxFailures` within `windowMs`. A valid token
 * never counts as a failure, so legitimate agents are only affected if they
 * share a client key with an attacker.
 *
 * Behind a proxy every request may arrive from the same address, so the
 * client key can come from a header (e.g. Cloudflare's CF-Connecting-IP)
 * configured via EMAIL_MCP_HTTP_CLIENT_IP_HEADER. Such a header is only as
 * trustworthy as the path to the server: if the origin is reachable without
 * the proxy, attackers can rotate it — the global tarpit below still slows
 * them, and a strong token remains the actual defence.
 */

export interface AuthLimiterOptions {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  /** Failures across all clients per window before every failure is delayed. */
  globalFailureBudget: number;
  tarpitMs: number;
  maxTrackedClients: number;
}

const DEFAULTS: AuthLimiterOptions = {
  maxFailures: 10,
  windowMs: 10 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
  globalFailureBudget: 200,
  tarpitMs: 2000,
  maxTrackedClients: 10_000,
};

interface ClientState {
  failures: number[];
  lockedUntil: number;
}

export type FailureOutcome =
  | { kind: 'counted'; delayMs: number }
  | { kind: 'locked'; retryAfterSec: number; delayMs: number; newlyLocked: boolean };

export default class AuthLimiter {
  private readonly opts: AuthLimiterOptions;

  private readonly clients = new Map<string, ClientState>();

  private globalFailures: number[] = [];

  constructor(
    options: Partial<AuthLimiterOptions> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Seconds until the client may try again, or 0 when not locked out. */
  lockedFor(client: string): number {
    const state = this.clients.get(client);
    const remaining = (state?.lockedUntil ?? 0) - this.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  recordFailure(client: string): FailureOutcome {
    const now = this.now();
    const since = now - this.opts.windowMs;

    this.globalFailures = this.globalFailures.filter((t) => t > since);
    this.globalFailures.push(now);
    // Only "over budget or not" matters, so never keep more than budget + 1.
    if (this.globalFailures.length > this.opts.globalFailureBudget + 1) this.globalFailures.shift();
    const delayMs =
      this.globalFailures.length > this.opts.globalFailureBudget ? this.opts.tarpitMs : 0;

    let state = this.clients.get(client);
    if (!state) {
      this.evictIfFull();
      state = { failures: [], lockedUntil: 0 };
      this.clients.set(client, state);
    }
    state.failures = state.failures.filter((t) => t > since);
    state.failures.push(now);

    if (state.failures.length >= this.opts.maxFailures) {
      const newlyLocked = state.lockedUntil <= now;
      state.lockedUntil = now + this.opts.lockoutMs;
      state.failures = [];
      return {
        kind: 'locked',
        retryAfterSec: Math.ceil(this.opts.lockoutMs / 1000),
        delayMs,
        newlyLocked,
      };
    }
    return { kind: 'counted', delayMs };
  }

  /** Bound memory under an attack that rotates client keys. */
  private evictIfFull(): void {
    if (this.clients.size < this.opts.maxTrackedClients) return;
    const now = this.now();
    for (const [key, state] of this.clients) {
      if (state.lockedUntil <= now) this.clients.delete(key);
      if (this.clients.size < this.opts.maxTrackedClients) return;
    }
    // Everything is locked: drop the oldest entry (Map keeps insertion order).
    const oldest = this.clients.keys().next().value;
    if (oldest !== undefined) this.clients.delete(oldest);
  }
}
