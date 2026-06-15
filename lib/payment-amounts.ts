// lib/payment-amounts.ts
//
// Pure money helpers for wallet top-ups. Deliberately dependency-free so they
// can be unit-tested in isolation (the rest of payment-cleanup-service needs
// Supabase + Paystack env even to import).

/**
 * The amount to CREDIT for a successful top-up: fee-EXCLUSIVE ("net").
 *
 * Prefer the authoritative net recorded in payment_attempts.amount. Only when
 * there is no attempt row do we derive it as gross - fee, where gross
 * (wallet_payments.amount) usually INCLUDES the Paystack fee.
 *
 * MUST use ?? (not ||): a real attempt amount of 0 — or a 0 gross — is valid and
 * must not fall through to the other branch. The historical `||` variant
 * over-credited the customer by the fee whenever payment_attempts had no row.
 */
export function netCreditAmount(
  attemptAmount: number | null | undefined,
  grossAmount: number,
  fee: number | null | undefined
): number {
  return attemptAmount ?? (grossAmount - (fee || 0))
}
