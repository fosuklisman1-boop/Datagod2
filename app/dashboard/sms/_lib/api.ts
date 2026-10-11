import { supabase } from "@/lib/supabase"

/** Current user's access token (empty string if not signed in). */
export async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ""
}

export type SmsResult<T> =
  | { ok: true; status: number; data: T; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; code?: string; body: Record<string, unknown> }

/**
 * Fetch wrapper for the customer SMS routes. Adds the Bearer token (and JSON
 * content-type when there is a string body) and normalises the many response
 * shapes: `{success,data}` envelopes, bare `{account,...}` objects, and
 * `{error, code?}` failures. `data` is `body.data` when present, else the body.
 * Never throws.
 */
export async function smsFetch<T = unknown>(path: string, init?: RequestInit): Promise<SmsResult<T>> {
  const t = await token()
  const headers: Record<string, string> = { Authorization: `Bearer ${t}` }
  if (typeof init?.body === "string") headers["Content-Type"] = "application/json"
  let res: Response
  try {
    res = await fetch(path, { ...init, headers: { ...headers, ...((init?.headers as Record<string, string>) || {}) } })
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "Network error", body: {} }
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.ok && body.success !== false && !body.error) {
    return { ok: true, status: res.status, data: ("data" in body ? body.data : body) as T, body }
  }
  const error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`
  return { ok: false, status: res.status, error, code: typeof body.code === "string" ? body.code : undefined, body }
}

// ─── response shapes ──────────────────────────────────────────────────────
export interface SmsAccount {
  id: string
  ownerType: string
  unitBalance: number
  pendingUnits: number
  status: string // 'inactive' | 'active' | 'suspended'
  bonusClaimed: boolean
  activatedAt: string | null
  activationFee: number
  welcomeBonusCredits: number
  pricePerCredit: number
}

export type SmsMode = "platform" | "business"

export interface SmsLimits { perSend: number; perHour: number; perDay: number }
export interface SmsStats { campaigns: number; recipients: number; creditsUsed: number }

/** Credit ledger row; `label` is the server-supplied customer wording (prefer it over recomputing). */
export interface LedgerEntry {
  id: number; delta: number; reason: string; balance_after: number | null
  send_log_id: number | null; created_at: string; label: string
}

export interface SmsHome {
  mode: SmsMode
  limits: SmsLimits
  stats: SmsStats
  recentLedger: LedgerEntry[]
  featureEnabled: boolean
}

export interface Page<T> { rows: T[]; total: number; page: number; pageSize: number }
