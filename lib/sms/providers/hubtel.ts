/**
 * Hubtel SMS REST API — the only file that knows Hubtel's wire format (spec §5.4).
 * Never throws: every call resolves to a classified result.
 */
export interface HubtelConfig {
  clientId: string
  clientSecret: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const HUBTEL_BATCH_CHUNK = 100 // docs give no limit; conservative until live-tested

export function hubtelConfigFromEnv(): HubtelConfig | null {
  const clientId = process.env.HUBTEL_SMS_CLIENT_ID
  const clientSecret = process.env.HUBTEL_SMS_CLIENT_SECRET
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** Hubtel expects 233XXXXXXXXX (no plus). */
export function toHubtelMsisdn(phone: string): string {
  const d = String(phone ?? "").replace(/\D/g, "")
  if (d.startsWith("233")) return d
  if (d.startsWith("0") && d.length === 10) return `233${d.slice(1)}`
  if (d.length === 9) return `233${d}`
  return d
}

export type HubtelOutcome = "accepted" | "rejected" | "out_of_funds" | "retryable"

export function classifyHubtelResponse(httpStatus: number, body: unknown): { outcome: HubtelOutcome; bodyStatus: number | null; error?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const bodyStatus = typeof b.status === "number" ? b.status : null
  const desc = typeof b.statusDescription === "string" ? b.statusDescription : typeof b.message === "string" ? b.message : ""
  if (httpStatus === 0) return { outcome: "retryable", bodyStatus, error: desc || "network error" }
  if (httpStatus === 402 || bodyStatus === 12) return { outcome: "out_of_funds", bodyStatus, error: "Hubtel account out of funds" }
  if (httpStatus >= 200 && httpStatus < 300) {
    if (bodyStatus === 0) return { outcome: "accepted", bodyStatus }
    return { outcome: "rejected", bodyStatus, error: `Hubtel status ${bodyStatus ?? "missing"}${desc ? `: ${desc}` : ""}` }
  }
  if (httpStatus === 401 || httpStatus >= 500) return { outcome: "retryable", bodyStatus, error: `Hubtel HTTP ${httpStatus}` }
  return { outcome: "rejected", bodyStatus, error: `Hubtel HTTP ${httpStatus}${bodyStatus !== null ? ` status ${bodyStatus}` : ""}${desc ? `: ${desc}` : ""}` }
}

export type HubtelDeliveryState = "delivered" | "pending" | "failed"
export function mapHubtelStatus(status: string | null | undefined): HubtelDeliveryState {
  const s = (status ?? "").trim().toLowerCase()
  if (s === "delivered") return "delivered"
  if (s === "" || s === "sent" || s === "pending") return "pending"
  return "failed"
}

export interface HubtelSendResult {
  outcome: HubtelOutcome
  httpStatus: number
  bodyStatus: number | null
  error?: string
  messageId?: string
  rate?: number
  batchId?: string
  messages: { recipient: string; messageId: string }[]
}

async function call(cfg: HubtelConfig, method: "GET" | "POST", path: string, payload?: unknown): Promise<{ status: number; body: unknown }> {
  const doFetch = cfg.fetchImpl ?? fetch
  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")
  try {
    const res = await doFetch(`${cfg.baseUrl ?? "https://sms.hubtel.com"}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
    })
    const text = await res.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* keep text */ }
    return { status: res.status, body }
  } catch (e) {
    return { status: 0, body: { message: String((e as Error)?.message ?? e) } }
  }
}

function toSendResult(status: number, body: unknown): HubtelSendResult {
  const c = classifyHubtelResponse(status, body)
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const data = Array.isArray(b.data) ? (b.data as Record<string, unknown>[]) : []
  return {
    outcome: c.outcome, httpStatus: status, bodyStatus: c.bodyStatus, error: c.error,
    messageId: typeof b.messageId === "string" ? b.messageId : undefined,
    rate: typeof b.rate === "number" ? b.rate : undefined,
    batchId: typeof b.batchId === "string" ? b.batchId : undefined,
    messages: data
      .filter((d) => typeof d.recipient === "string" && typeof d.messageId === "string")
      .map((d) => ({ recipient: d.recipient as string, messageId: d.messageId as string })),
  }
}

export async function hubtelSendSingle(cfg: HubtelConfig, m: { from: string; to: string; content: string }): Promise<HubtelSendResult> {
  const r = await call(cfg, "POST", "/v1/messages/send", { From: m.from, To: toHubtelMsisdn(m.to), Content: m.content })
  return toSendResult(r.status, r.body)
}

export async function hubtelSendBatchSimple(cfg: HubtelConfig, m: { from: string; recipients: string[]; content: string }): Promise<HubtelSendResult> {
  const r = await call(cfg, "POST", "/v1/messages/batch/simple/send", { From: m.from, Recipients: m.recipients.map(toHubtelMsisdn), Content: m.content })
  return toSendResult(r.status, r.body)
}

export async function hubtelSendBatchPersonalized(cfg: HubtelConfig, m: { from: string; items: { to: string; content: string }[] }): Promise<HubtelSendResult> {
  const r = await call(cfg, "POST", "/v1/messages/batch/personalized/send", {
    From: m.from,
    personalizedRecipients: m.items.map((i) => ({ To: toHubtelMsisdn(i.to), Content: i.content })),
  })
  return toSendResult(r.status, r.body)
}

export interface HubtelStatusEntry { messageId: string; state: HubtelDeliveryState; rawStatus: string; rate?: number; updateTime?: string }
export interface HubtelStatusResult { ok: boolean; error?: string; messages: HubtelStatusEntry[] }

function toEntry(d: Record<string, unknown>): HubtelStatusEntry | null {
  if (typeof d.messageId !== "string") return null
  const raw = typeof d.status === "string" ? d.status : ""
  return {
    messageId: d.messageId, state: mapHubtelStatus(raw), rawStatus: raw,
    rate: typeof d.rate === "number" ? d.rate : undefined,
    updateTime: typeof d.updateTime === "string" ? d.updateTime : undefined,
  }
}

export async function hubtelGetBatchStatus(cfg: HubtelConfig, batchId: string): Promise<HubtelStatusResult> {
  const r = await call(cfg, "GET", `/v1/messages/batch/${encodeURIComponent(batchId)}`)
  if (r.status < 200 || r.status >= 300) return { ok: false, error: `Hubtel HTTP ${r.status}`, messages: [] }
  const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>
  const data = Array.isArray(b.data) ? (b.data as Record<string, unknown>[]) : []
  return { ok: true, messages: data.map(toEntry).filter((e): e is HubtelStatusEntry => e !== null) }
}

export async function hubtelGetMessageStatus(cfg: HubtelConfig, messageId: string): Promise<HubtelStatusResult> {
  const r = await call(cfg, "GET", `/v1/messages/${encodeURIComponent(messageId)}`)
  if (r.status < 200 || r.status >= 300) return { ok: false, error: `Hubtel HTTP ${r.status}`, messages: [] }
  const e = toEntry((r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>)
  return { ok: true, messages: e ? [e] : [] }
}
