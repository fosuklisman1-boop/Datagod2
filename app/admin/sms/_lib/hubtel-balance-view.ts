/** Pure view helpers for the manual Hubtel balance fallback (no React, no I/O — unit-tested). */
import { formatGhs, providerLabel, type Parsed, type Tone } from "./view"

export type HubtelBalanceCurrent =
  | { ok: true; amountGhs: number; source: "relay" }
  | { ok: true; amountGhs: number; source: "manual"; manualSetAt: string; preferred?: true }
  | { ok: false; error: string }

export type RelayReading = { ok: true; amountGhs: number } | { ok: false; error: string }

export interface HubtelBalanceData {
  current: HubtelBalanceCurrent
  manual: { amountGhs: number; setAt: string; setBy: string; fresh: boolean } | null
  /** Admin chose the manual balance over the relay (the relay reads a different wallet). */
  preferManual: boolean
  /** Raw relay /balance reading — information only. */
  relay: RelayReading
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

export const PREFER_MANUAL_LABEL = "Use my manual balance instead of the relay — the relay reads a different Hubtel wallet"
export const PREFER_MANUAL_HELP =
  "The relay reads the Hubtel Disbursement wallet, but Hubtel SMS is paid from a separate SMS wallet the app can't read yet. Turn this on so credit sales are backed by your manual SMS balance (minus SMS sent since) instead of the relay figure."
export const PREFER_MANUAL_CONFIRM =
  "From now on the relay balance is not used at all for SMS credit sales — only your manual balance minus the SMS sent since. If the manual balance is missing or older than 30 days, credit sales pause until you set it again."

export const MANUAL_AMOUNT_LABEL = "Current Hubtel SMS balance (GH₵) — the SMS wallet, not Disbursement"

/** "Set balance now" dialog: how long the manual figure is used depends on the prefer switch. */
export function setBalanceUsageText(preferManual: boolean): string {
  return preferManual
    ? "This manual balance is used for credit-sales checks until you turn the switch off."
    : "Credit sales will be backed by this amount minus the Hubtel SMS sent from now on, until the live balance check works again."
}

/** Turn-off confirmation: say what the gate falls back to. */
export function preferOffConfirmText(r: RelayReading): string {
  const now = r.ok ? `currently ${formatGhs(r.amountGhs)} — Disbursement wallet` : `currently unavailable — ${r.error}`
  return `Credit-sales checks will go back to the relay reading (${now}), and credit sales may pause immediately if that is 0.`
}

/** The relay figure, always labelled as the Disbursement wallet so it is never mistaken for the SMS balance. */
export function relayInfoText(r: RelayReading): string {
  return r.ok ? `Relay reads ${formatGhs(r.amountGhs)} — Disbursement wallet` : `Relay unavailable — ${r.error}`
}

export function balanceSourceSummary(c: HubtelBalanceCurrent): { tone: Tone; label: string } {
  if (!c.ok) return { tone: "danger", label: `Unavailable — ${c.error}` }
  if (c.source === "relay") return { tone: "success", label: "Live Hubtel balance (relay)" }
  return { tone: "warning", label: c.preferred ? "Manual estimate (preferred over the relay)" : "Manual estimate" }
}
