export interface PendingReferencePolicy {
  /** quantas vezes a referência é procurada de novo antes de rejeitar com REFERENCE_NOT_FOUND */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** 1+2+4+8+16+32+60+60+60+60 s ≈ 5 min: cobre entrega fora de ordem típica sem reter a pendência para sempre. */
export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/** `attempt` é o número da tentativa que está sendo agendada (1, 2, 3...). */
export function pendingReferenceBackoffMs(
  attempt: number,
  policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}