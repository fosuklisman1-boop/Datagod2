// HTTP client for the Kuntanii integrations API. Injectable so the provider,
// whitelist, disputes and cron code can be tested with a fake. Never logs the
// API key or phone numbers.

import { classifyKuntaniiError, type KuntaniiMode, type KuntaniiOrderEntry, type KuntaniiPlan } from "./kuntanii-core"

export type KuntaniiOk<T> = { ok: true; status: number; data: T }
export type KuntaniiErr = {
  ok: false
  status: number
  code?: string
  message: string
  body?: unknown
  network?: boolean
}
export type KuntaniiResult<T> = KuntaniiOk<T> | KuntaniiErr

export type PricingBody = { deliveryMode: KuntaniiMode; pricingProfileName?: string; plans: KuntaniiPlan[] }
export type VerifyResult = {
  phoneNumber: string
  normalizedPhone?: string
  eligible: boolean
  reason: string
  message?: string
}
export type OrderBody = {
  externalOrderId: string
  deliveryMode?: string
  outcome?: string
  acceptedCount?: number
  totalAmountGhs?: number
  orderReference?: string
  status?: string
  idempotent?: boolean
  orders?: KuntaniiOrderEntry[]
  rejectedRecipients?: Array<{ phoneNumber: string; dataGb: number; reason: string }>
}
export type ReportBody = { reportReference: string; orderReference?: string; disputeStatus?: string; status?: string }

export interface KuntaniiClient {
  getPricing(mode: KuntaniiMode): Promise<KuntaniiResult<PricingBody>>
  verifyBeneficiaries(phones: string[]): Promise<KuntaniiResult<{ results: VerifyResult[] }>>
  getOrder(externalOrderId: string): Promise<KuntaniiResult<OrderBody>>
  placeOrder(input: {
    externalOrderId: string
    phoneNumber: string
    dataGb: number
    mode: KuntaniiMode
  }): Promise<KuntaniiResult<OrderBody>>
  reportNotReceived(
    externalOrderId: string,
    body: { phoneNumber: string; dataGb?: number; reasonCode?: string; description?: string },
  ): Promise<KuntaniiResult<ReportBody>>
  getNotReceivedStatus(externalOrderId: string, reportReference: string): Promise<KuntaniiResult<{ status: string }>>
}

const DEFAULT_TIMEOUT_MS = 30_000
const RETRY_DELAY_MS = 2000
const PLAN_CACHE_TTL_MS = 300_000

export function createKuntaniiClient(opts?: {
  fetchImpl?: typeof fetch
  apiKey?: string
  baseUrl?: string
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}): KuntaniiClient {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const doFetch: typeof fetch =
    opts?.fetchImpl ?? ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }))

  const base = () => (opts?.baseUrl ?? process.env.KUNTANII_BASE_URL ?? "https://kuntanii.com").replace(/\/+$/, "")
  const key = () => opts?.apiKey ?? process.env.KUNTANII_API_KEY ?? ""

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<KuntaniiResult<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    }
    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)

    let res: Response
    try {
      res = await doFetch(`${base()}${path}`, init)
    } catch (e: any) {
      return { ok: false, status: 0, network: true, message: String(e?.message ?? e ?? "network error") }
    }

    let parsed: unknown
    let parsedOk = true
    try {
      parsed = await res.json()
    } catch {
      parsedOk = false
    }
    const obj =
      parsedOk && parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
    const code = obj && typeof obj.code === "string" ? obj.code : undefined

    if (res.status >= 200 && res.status < 300 && parsedOk && obj?.success !== false) {
      return { ok: true, status: res.status, data: parsed as T }
    }
    const message = obj && typeof obj.message === "string" ? obj.message : `HTTP ${res.status}`
    return { ok: false, status: res.status, code, message, body: parsedOk ? parsed : undefined }
  }

  return {
    getPricing(mode) {
      const qs = mode === "instant" ? "?deliveryMode=instant" : ""
      return request<PricingBody>("GET", `/api/integrations/pricing${qs}`)
    },
    verifyBeneficiaries(phones) {
      return request("POST", "/api/integrations/beneficiaries/verify", { phoneNumbers: phones })
    },
    getOrder(externalOrderId) {
      return request<OrderBody>("GET", `/api/integrations/orders/${encodeURIComponent(externalOrderId)}`)
    },
    async placeOrder({ externalOrderId, phoneNumber, dataGb, mode }) {
      const body: Record<string, unknown> = { externalOrderId }
      if (mode === "instant") body.deliveryMode = "instant"
      body.items = [{ phoneNumber, dataGb }]
      const headers = { "X-Kuntanii-Idempotency-Key": externalOrderId }
      const attempt = () => request<OrderBody>("POST", "/api/integrations/orders", body, headers)

      const first = await attempt()
      if (first.ok) return first
      const retryable = first.network === true || classifyKuntaniiError(first.status, first.code, mode) === "RETRYABLE"
      if (!retryable) return first
      await sleep(RETRY_DELAY_MS)
      return attempt()
    },
    reportNotReceived(externalOrderId, body) {
      return request<ReportBody>("POST", `/api/integrations/orders/${encodeURIComponent(externalOrderId)}/not-received`, body)
    },
    getNotReceivedStatus(externalOrderId, reportReference) {
      const qs = new URLSearchParams({ reportReference }).toString()
      return request<{ status: string }>(
        "GET",
        `/api/integrations/orders/${encodeURIComponent(externalOrderId)}/not-received?${qs}`,
      )
    },
  }
}

const planCache = new Map<KuntaniiMode, { at: number; plans: KuntaniiPlan[] }>()

export async function getCachedPlans(
  client: KuntaniiClient,
  mode: KuntaniiMode,
  now: number = Date.now(),
): Promise<KuntaniiPlan[] | null> {
  const hit = planCache.get(mode)
  if (hit && now - hit.at <= PLAN_CACHE_TTL_MS) return hit.plans
  const res = await client.getPricing(mode)
  if (!res.ok || !Array.isArray(res.data?.plans)) return null
  planCache.set(mode, { at: now, plans: res.data.plans })
  return res.data.plans
}

export function __resetPlanCache(): void {
  planCache.clear()
}
