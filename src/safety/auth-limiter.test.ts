import AuthLimiter from './auth-limiter.js';

describe('AuthLimiter', () => {
  it('locks a client out after maxFailures within the window', () => {
    let now = 1_000_000;
    const limiter = new AuthLimiter(
      { maxFailures: 3, windowMs: 60_000, lockoutMs: 300_000 },
      () => now,
    );
    expect(limiter.recordFailure('a').kind).toBe('counted');
    expect(limiter.recordFailure('a').kind).toBe('counted');
    const third = limiter.recordFailure('a');
    expect(third).toMatchObject({ kind: 'locked', newlyLocked: true, retryAfterSec: 300 });
    expect(limiter.lockedFor('a')).toBe(300);
    expect(limiter.lockedFor('b')).toBe(0);

    now += 299_000;
    expect(limiter.lockedFor('a')).toBe(1);
    now += 2_000;
    expect(limiter.lockedFor('a')).toBe(0);
  });

  it('forgets failures outside the window', () => {
    let now = 0;
    const limiter = new AuthLimiter({ maxFailures: 3, windowMs: 1_000 }, () => now);
    limiter.recordFailure('a');
    limiter.recordFailure('a');
    now += 2_000;
    expect(limiter.recordFailure('a').kind).toBe('counted');
    expect(limiter.lockedFor('a')).toBe(0);
  });

  it('tarpits every failure once the global budget is exceeded', () => {
    const limiter = new AuthLimiter({ globalFailureBudget: 5, tarpitMs: 1500, maxFailures: 100 });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.recordFailure(`client-${i}`)).toEqual({ kind: 'counted', delayMs: 0 });
    }
    expect(limiter.recordFailure('client-new')).toEqual({ kind: 'counted', delayMs: 1500 });
  });

  it('bounds memory when attackers rotate client keys', () => {
    const limiter = new AuthLimiter({ maxTrackedClients: 3, maxFailures: 100 });
    for (let i = 0; i < 50; i += 1) limiter.recordFailure(`rotating-${i}`);
    expect(
      (limiter as unknown as { clients: Map<string, unknown> }).clients.size,
    ).toBeLessThanOrEqual(3);
  });
});
