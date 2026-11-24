// Browser-safe helpers for the Developers tab: confirm copy, badges, the ?dev= parameter and error text.
import { rejectReasonOk } from "@/lib/api-v2/console-tabs"

export const SEARCH_DEBOUNCE_MS = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** ?dev=<uuid> opens that profile; anything else is ignored. */
export function parseDevParam(v: string | null): string | null {
  return v && UUID_RE.test(v) ? v.toLowerCase() : null
}

/** Same rule as the SQL function: 3-200 characters after trimming. */
export const pauseReasonOk = rejectReasonOk

export function pauseCopy(pausing: boolean): { title: string; body: string; confirm: string; needsReason: boolean } {
  return pausing
    ? {
        title: "Pause API access for this developer?",
        body: "This blocks every key for this person (live and test) within a few seconds. Nothing is revoked and their keys stay as they are, so this is reversible: unpause to restore access.",
        confirm: "Pause access",
        needsReason: true,
      }
    : {
        title: "Unpause API access?",
        body: "Their existing keys work again within a few seconds.",
        confirm: "Unpause",
        needsReason: false,
      }
}

export type BadgeTone = "red" | "primary" | "amber"

/** Badges carry words, never colour alone. */
export function developerBadges(r: { paused: boolean; granted: boolean }): { label: string; tone: BadgeTone }[] {
  const out: { label: string; tone: BadgeTone }[] = []
  if (r.paused) out.push({ label: "PAUSED", tone: "red" })
  if (r.granted) out.push({ label: "API access granted", tone: "primary" })
  return out
}

/** A failed pause/unpause is always shown to the admin. */
export function pauseErrorText(status: number, error: string | null): string {
  if (status === 0) return "Network error. Check your connection and try again."
  if (status === 404) return error ?? "Developer not found."
  if (status === 409) return error ?? "This changed in the meantime. Refresh and try again."
  return error ?? `Request failed (${status}).`
}

export const ghs = (n: number) => `GHS ${n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const pct = (n: number | null) => (n === null ? "No calls" : `${n}%`)
