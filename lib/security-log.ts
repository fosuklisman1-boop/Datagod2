/**
 * Lightweight structured security logger.
 *
 * Emits a single greppable `[SECURITY] <event>` line to the server logs (visible
 * in Vercel) for anti-abuse signals — gate blocks, direct-charge bypass attempts,
 * and fail-closed fallbacks. Phone numbers are masked. It is best-effort and
 * side-effect-free: it never throws and never blocks the request.
 *
 * Filter the Vercel logs by `[SECURITY]` to triage abuse without leaving the
 * platform; each line is JSON after the prefix so it can be parsed/aggregated.
 */

/** 024XXXXXXX → 024****67  (enough to correlate, not enough to expose). */
export function maskPhone(phone?: string | null): string {
  if (!phone) return ""
  const d = String(phone).replace(/\D/g, "")
  if (d.length < 5) return "***"
  return d.slice(0, 3) + "****" + d.slice(-2)
}

export function logSecurityEvent(event: string, details: Record<string, any> = {}): void {
  try {
    const safe: Record<string, any> = { ...details }
    if (safe.phone) safe.phone = maskPhone(safe.phone)
    if (safe.paymentPhone) safe.paymentPhone = maskPhone(safe.paymentPhone)
    if (safe.recipient) safe.recipient = maskPhone(safe.recipient)
    console.warn(`[SECURITY] ${event}`, JSON.stringify({ ts: new Date().toISOString(), ...safe }))
  } catch {
    // Logging must never break a request.
  }
}
