import { supabase } from "@/lib/supabase"

export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, status: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

async function token(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

/** Admin fetch. Throws ApiError carrying only the API's short error code. cache: no-store, nothing is kept beyond component state. */
export async function adminFetch<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const t = await token()
  const res = await fetch(path, {
    method: init.method ?? "GET",
    cache: "no-store",
    headers: { Authorization: `Bearer ${t}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(typeof json.error === "string" ? json.error : "server_error", res.status)
  return json as T
}

export const TTB_API = "/api/admin/text-to-buy"

export type Settings = {
  mainEnabled: boolean
  mainNumber: string
  replySenderId: string
  aiEnabled: boolean
  staleMinutes: number
  promptsPerHour: number
  repliesPerHour: number
  aiReadsPerHour: number
  globalPromptsPerMinute: number
  promptWindowMinutes: number
  quietAlertMinutes: number
  retentionDays: number
}

export type LineOverview = {
  enabled: boolean
  number: string
  lastHeardAt: string | null
  today: { texts: number; prompts: number; paid: number; delivered: number; replies: number; aiReads: number; ruleReads: number }
  smsCostGhs: number
}

export type OverviewResponse = {
  settingsDefaulted: boolean
  settings: Settings
  overview: { main: LineOverview; shop: LineOverview }
  smsRateGhs: number
}

export type AdminMessage = {
  id: string
  createdAt: string
  line: "main" | "shop"
  sender: string
  direction: "in" | "out"
  body: string
  readBy: "rules" | "ai" | null
  outcome: string | null
  orderLinkId: string | null
  misread: boolean
}

export type MessagesPage = { rows: AdminMessage[]; nextCursor: string | null }
