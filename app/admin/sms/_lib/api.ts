/** Admin fetch helpers + response shapes for the SMS Platform page. */
import { authToken } from "../../sms-centre/_lib/api"
export { api, authToken } from "../../sms-centre/_lib/api"
export type { ApiResult } from "../../sms-centre/_lib/api"

/** For legacy admin routes that don't use the {success,data} envelope (bundles, allocate). */
export async function apiRaw<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T | null }> {
  try {
    const t = await authToken()
    const res = await fetch(path, {
      ...init,
      headers: { Authorization: `Bearer ${t}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) },
    })
    let body: T | null = null
    try { body = (await res.json()) as T } catch { body = null }
    return { ok: res.ok, status: res.status, body }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}

export interface Page<T> { rows: T[]; total: number; page: number; pageSize: number }
export interface AccountInfo { user_id: string; email: string | null; mode: "platform" | "business"; owner_type: string }

export interface Supply { provider: "hubtel" | "moolre"; backedCredits: number; balanceGhs: number | null; ratePerSms: number | null; queuedUnsent: number | null; error?: string }
export interface OverviewData {
  stats: { recordedRevenueGhs: number; bundleRevenueGhs: number; activationRevenueGhs: number; creditsSold: number; purchases: number; pendingReviews: number; pendingSenders: number; fraudFlags: number }
  tabCounts: { businessReviews: number; senderIds: number; flagged: number }
  unrecorded: { purchases: number; credits: number }
  supply: Supply
  featureEnabled: boolean
  policyEnforced: boolean
  provider: string
  policyPreview: { decision: string; code: string; count: number }[]
}

export interface ReviewRow {
  id: string; sms_account_id: string; business_name: string | null; description: string | null; website: string | null
  whatsapp_number: string | null; ghana_card_last4: string | null; status: "draft" | "submitted" | "approved" | "rejected"
  submitted_at: string | null; reviewed_at: string | null; rejection_reason: string | null; created_at: string
  has_ghana_card_doc: boolean; has_registration_doc: boolean; account: AccountInfo | null
}
export type ReviewDetail = Omit<ReviewRow, "account"> & { ghana_card_doc_url: string | null; registration_doc_url: string | null }

export interface SenderRow {
  id: string; sender_id: string; local_status: string; kyc_free: boolean; is_pool: boolean
  approved_at: string | null; revoked_at: string | null; rejection_reason: string | null
  submitted_at: string | null; created_at: string; sms_account_id: string | null; account: AccountInfo | null
}
export interface MessageRow {
  id: number; sms_account_id: string; user_id: string; mode: string | null; sender_id: string | null; status: string
  recipients_count: number; segments: number; credits_used: number; message: string; created_at: string
  tracked: number | string; delivered: number | string; failed: number | string; pending: number | string
}
export interface AccountRow {
  id: string; user_id: string; email: string | null; owner_type: string; mode: "platform" | "business"; status: string
  unit_balance: number; bought: number | string; used: number | string; default_sender: string | null
  api_rate_limit_override: number | null; review_hold: boolean; fraud_flag_count: number; created_at: string
}
export interface FlagRow {
  id: string; source: "flag" | "legacy"; sms_account_id: string; user_id: string; severity: "fraud" | "info"
  reason: string; matched: string | null; status: string; message: string | null; created_at: string
}
export interface BundleRow {
  id: string; name: string; units: number; price_ghs: number | string; owner_type_scope: string
  active: boolean; mode: "platform" | "business"; sort_order: number; updated_at?: string
}
export interface SettingsData {
  settings: {
    featureEnabled: boolean; policyEnforced: boolean; allowedRoles: string[]; senderPool: string[]
    caps: Record<"platform" | "business", { per_send: number; per_hour: number; per_day: number }>
    blockedKeywords: string[]; businessBlockedKeywords: string[]; businessFlaggedKeywords: string[]; businessAllowedDomains: string[]
    autoSuspendFlags: number; flagReviewThreshold: number; apiRateLimitDefault: number
    hubtelCostPerSms: number; hubtelLowBalanceGhs: number
  }
  pricing: { activationFee: number; welcomeBonusCredits: number; pricePerCredit: number }
}
