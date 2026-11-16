import { supabase } from "@/lib/supabase"

export class ApiError extends Error {
  code: string
  field?: string
  body: Record<string, unknown>
  constructor(code: string, field?: string, body: Record<string, unknown> = {}) {
    super(code)
    this.code = code
    this.field = field
    this.body = body
  }
}

async function token(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

/** Admin fetch. Throws ApiError carrying only the API's short error code (never raw text). */
export async function adminFetch<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const t = await token()
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${t}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiError(typeof json.error === "string" ? json.error : "server_error", typeof json.field === "string" ? json.field : undefined, json)
  }
  return json as T
}

export const MOMO_API = "/api/admin/momo-claims"

export type Tx = {
  id: string
  transaction_id: string
  network: string | null
  amount: number | null
  fee: number | null
  net_amount: number | null
  status: string
  flag_reasons: string[] | null
  session_id: string | null
  claimed_by: string | null
  received_at: string
}

export type Settings = {
  enabled: boolean
  accounts: { network: "MTN" | "Telecel" | "AirtelTigo"; number: string }[]
  accountName: string
  feeCustomerPercent: number
  feeDealerPercent: number
  minNet: number
  maxSent: number
  senderAllowlist: string[]
  regressionThreshold: number
  reviewThreshold: number
  dailyCap: number
  firstClaimReview: boolean
}

export type ListResponse = {
  transactions: Tx[]
  counts: Record<string, number>
  suspicious: { userId: string; attempts: number }[]
  settings: Settings
  settingsDefaulted: boolean
}
