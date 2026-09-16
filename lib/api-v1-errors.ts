// lib/api-v1-errors.ts

export interface ServiceErrorClassification {
  status: number
  publicMessage: string
  isKnown: boolean
}

/**
 * Classify a thrown service-layer error for a v1 API response. A "known"
 * business error (one of the codes in statusByCode, e.g. INSUFFICIENT_BALANCE)
 * surfaces its own deliberately-worded message at its mapped status. Anything
 * else — a bug, a raw Supabase/Postgres error, any exception the service layer
 * didn't anticipate — must NOT leak its message to a third-party API consumer,
 * so it gets the route's generic fallback message at 500.
 *
 * A known code that itself represents a 500-level failure (e.g.
 * ORDER_CREATE_FAILED) should still be listed in statusByCode mapped to 500 —
 * that's what makes it "known" (message surfaced) rather than "unknown"
 * (message suppressed), even though the HTTP status is the same either way.
 */
export function classifyServiceError(
  error: unknown,
  statusByCode: Record<string, number>,
  defaultMessage: string
): ServiceErrorClassification {
  const code = (error as { code?: unknown })?.code
  const isKnown = typeof code === "string" && Object.prototype.hasOwnProperty.call(statusByCode, code)

  if (isKnown) {
    return {
      status: statusByCode[code as string],
      publicMessage: (error as Error).message,
      isKnown: true,
    }
  }
  return { status: 500, publicMessage: defaultMessage, isKnown: false }
}
