/**
 * SMS master switch (Phase 2, spec §6). The only newly ENFORCED admin control; all other
 * policy rules stay record-only until Phase 3. Settings are cached (60 s per instance) by
 * loadSmsSettings, so a flip reaches every instance within about a minute. Fails OPEN: a
 * database blip must never stop sending.
 */
import { loadSmsSettings } from "./platform-settings"

export const SMS_DISABLED_MESSAGE = "SMS is temporarily unavailable. Please try again later."

export async function isSmsEnabled(): Promise<boolean> {
  try {
    return (await loadSmsSettings()).featureEnabled
  } catch {
    return true
  }
}
