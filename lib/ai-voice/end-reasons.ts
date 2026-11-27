// The end reasons a client may report. Server-set reasons (cap_exceeded, count_failed, mint_*) are NOT here:
// the daily-cap counts exclude cap_exceeded rows, so a client that could write that value could escape the caps.
export const CLIENT_END_REASONS = [
  "user", "page_left", "ended", "closed", "connect_failed", "start_failed", "token_failed", "fallback",
  "content", "age_check", "policy-violation", "age-check", "expired", "end_call", "error", "connection_lost", "timeout",
] as const

const SET: ReadonlySet<string> = new Set(CLIENT_END_REASONS)

export const isClientEndReason = (r: string): boolean => SET.has(r)

/** Maps any reason the SDK or Nuance hands us to one the end route accepts. */
export const toClientEndReason = (r: string): string => (SET.has(r) ? r : "ended")

/** Reasons that mean the call was stopped for content or age: the next call for this identity is refused. */
export const POLICY_END_REASONS = ["content", "age_check", "policy-violation", "age-check"] as const
