/**
 * Per-account outbound attachment limit resolution.
 *
 * The goal is to catch "this provider will bounce it" before the SMTP
 * transaction, so the effective limit is the strictest of the global setting
 * and the provider's documented cap — unless the account sets its own
 * explicit limit, which always wins (the escape hatch for providers that
 * raise limits or self-hosted relays).
 */

import { findProviderForAccount } from './providers.js';

/** Fallback cap (MB, base64-encoded total) when nothing more specific is known. */
export const DEFAULT_SEND_LIMIT_MB = 25;

export interface SendLimitAccount {
  email: string;
  smtp: { host: string };
  /** Optional explicit per-account cap from `max_attachment_mb`. */
  maxAttachmentMb?: number;
}

/** Resolve the effective attachment cap (MB) for one account. */
export function resolveSendLimitMb(account: SendLimitAccount, globalMb: number): number {
  if (account.maxAttachmentMb !== undefined) return account.maxAttachmentMb;
  const providerMb = findProviderForAccount(account)?.maxAttachmentMb;
  return providerMb === undefined ? globalMb : Math.min(globalMb, providerMb);
}
