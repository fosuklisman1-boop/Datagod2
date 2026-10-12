/** Pure view helpers for the manual Hubtel balance fallback (no React, no I/O — unit-tested). */
import { providerLabel, type Parsed, type Tone } from "./view"

export type HubtelBalanceCurrent =
  | { ok: true; amountGhs: number; source: "relay" }
  | { ok: true; amountGhs: number; source: "manual"; manualSetAt: string }
  | { ok: false; error: string }

export interface HubtelBalanceData {
  current: HubtelBalanceCurrent
  manual: { amountGhs: number; setAt: string; setBy: string; fresh: boolean } | null
}

/** Supply strip heading: a manual estimate must never read like a live balance. */
export function supplyProviderLabel(provider: string, s: { balanceSource?: "relay" | "manual" }): string {
  return provider === "hubtel" && s.balanceSource === "manual" ? "Hubtel (manual estimate)" : providerLabel(provider)
}

/** Amount typed by the admin: GH₵ 0–1,000,000, at most 2 decimals (commas allowed). */
export function parseManualBalanceInput(input: string): Parsed<number> {
  const t = (input ?? "").trim().replace(/,/g, "")
  const n = Number(t)
  if (/^\d+(\.\d{1,2})?$/.test(t) && n >= 0 && n <= 1_000_000) return { ok: true, value: n }
  return { ok: false, error: "Enter an amount in GH₵ from 0 to 1,000,000 (at most 2 decimals)" }
}

/** Reminders shown under the amount input. */
export const MANUAL_BALANCE_NOTES: readonly string[] = [
  "Update it after every top-up — \"Set balance now\" restarts the count from this moment.",
  "Not counted, so the estimate can be slightly high: messages sent outside this app (e.g. test requests sent by hand), and in-app sends that skip the SMS log — admin notify, notify-self, AI tasks and admin-broadcast retries.",
  "A manual balance older than 30 days is ignored, and credit sales pause until it is set again.",
]

export const SET_BALANCE_CONFIRM_NOTE =
  "Enter the balance exactly as shown on the Hubtel dashboard right now — messages sent in the gap before you click are not counted."

export function balanceSourceSummary(c: HubtelBalanceCurrent): { tone: Tone; label: string } {
  if (!c.ok) return { tone: "danger", label: `Unavailable — ${c.error}` }
  return c.source === "relay" ? { tone: "success", label: "Live Hubtel balance (relay)" } : { tone: "warning", label: "Manual estimate" }
}
