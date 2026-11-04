/**
 * Recipient limits for ONE send. Dependency-free on purpose (type-only imports) so routes,
 * services and the admin validator share it without pulling in Supabase clients, and test
 * files that mock ./platform-settings wholesale don't lose these exports.
 */
import type { SmsMode, SmsPlatformSettings } from "./platform-settings"

/**
 * System ceiling: a request fans out into sequential 500-recipient batches inside a 300 s
 * function, so this is technical, not policy. Admin per-send caps above it can never take
 * effect (the caps validator refuses them).
 */
export const SMS_HARD_MAX_PER_SEND = 5000

/** The per-send recipient limit an account actually gets: its mode's admin cap, within the ceiling. */
export function effectivePerSend(settings: Pick<SmsPlatformSettings, "caps">, mode: SmsMode | undefined): number {
  return Math.min(settings.caps[mode === "business" ? "business" : "platform"].per_send, SMS_HARD_MAX_PER_SEND)
}
