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
  let d = String(phone ?? "").replace(/\D/g, "")
  if (d.startsWith("00")) d = d.slice(2)
  if (d.startsWith("2330") && d.length === 13) return `233${d.slice(4)}`
  if (d.startsWith("233")) return d
  if (d.startsWith("0") && d.length === 10) return `233${d.slice(1)}`
  if (d.length === 9) return `233${d}`
  return d
}

export function isValidHubtelMsisdn(s: string): boolean {
  return /^233[235]\d{8}$/.test(s)
}

/**
 * "unknown" = Hubtel may have accepted the message. Callers must treat it as sent:
 * never fall back to another provider, never refund immediately.
 */
export type HubtelOutcome = "accepted" | "rejected" | "out_of_funds" | "retryable" | "unknown"
export type HubtelFailure = "none" | "connect" | "timeout" | "body_read"

function numericStatus(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

export function classifyHubtelResponse(
  httpStatus: number,
  body: unknown,
  failure: HubtelFailure = "none",
): { outcome: HubtelOutcome; bodyStatus: number | null; error?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const bodyStatus = numericStatus(b.status)
  const desc = typeof b.statusDescription === "string" ? b.statusDescription : typeof b.message === "string" ? b.message : ""
  if (failure === "connect") return { outcome: "retryable", bodyStatus, error: desc || "connection failed before send" }
  if (failure === "timeout") return { outcome: "unknown", bodyStatus, error: desc || "no response from Hubtel (may have been accepted)" }
  if (failure === "body_read" && httpStatus >= 200 && httpStatus < 300) {
    return { outcome: "unknown", bodyStatus, error: "Hubtel response body unreadable (may have been accepted)" }
  }
  if (httpStatus === 402 || bodyStatus === 12) return { outcome: "out_of_funds", bodyStatus, error: "Hubtel account out of funds" }
  if (httpStatus >= 200 && httpStatus < 300) {
    if (bodyStatus === 0) return { outcome: "accepted", bodyStatus }
    if (bodyStatus !== null) return { outcome: "rejected", bodyStatus, error: `Hubtel status ${bodyStatus}${desc ? `: ${desc}` : ""}` }
    if (typeof b.messageId === "string" || typeof b.batchId === "string") return { outcome: "accepted", bodyStatus }
    return { outcome: "unknown", bodyStatus, error: "Hubtel 2xx response without a recognisable status" }
  }
  if ([408, 429, 401, 503].includes(httpStatus)) return { outcome: "retryable", bodyStatus, error: `Hubtel HTTP ${httpStatus}` }
  if ([500, 502, 504].includes(httpStatus)) return { outcome: "unknown", bodyStatus, error: `Hubtel HTTP ${httpStatus}` }
  return { outcome: "rejected", bodyStatus, error: `Hubtel HTTP ${httpStatus}${bodyStatus !== null ? ` status ${bodyStatus}` : ""}${desc ? `: ${desc}` : ""}` }
}

export type HubtelDeliveryState = "delivered" | "pending" | "failed"
export function mapHubtelStatus(status: string | null | undefined): HubtelDeliveryState {
  const s = (status ?? "").trim().toLowerCase()
  if (s === "delivered") return "delivered"
  if (s === "blacklisted" || s === "rejected" || s.startsWith("nack") ||
    s.includes("undeliver") || s.includes("unrout") || s.includes("fail") || s.includes("error")) return "failed"
  return "pending"
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

const CONNECT_CODES = [
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH",
  "ERR_INVALID_URL", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]

function isConnectCode(code: unknown): boolean {
  const c = String(code ?? "")
  return CONNECT_CODES.includes(c) || c.startsWith("ERR_TLS") || c.startsWith("ERR_SSL") || c.includes("CERT")
}

function failureForFetchError(e: unknown): HubtelFailure {
  const err = e as { name?: string; code?: string; cause?: { code?: string; errors?: { code?: string }[] } } | null
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout"
  const codes: unknown[] = [err?.code, err?.cause?.code]
  if (Array.isArray(err?.cause?.errors)) for (const x of err.cause.errors) codes.push(x?.code)
  if (codes.some(isConnectCode)) return "connect"
  return "timeout" // ambiguous => maybe sent
}

async function call(cfg: HubtelConfig, method: "GET" | "POST", path: string, payload?: unknown): Promise<{ status: number; body: unknown; failure: HubtelFailure }> {
  const doFetch = cfg.fetchImpl ?? fetch
  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")
  let res: Response
  try {
    res = await doFetch(`${cfg.baseUrl ?? "https://sms.hubtel.com"}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
    })
  } catch (e) {
    const failure = failureForFetchError(e)
    return { status: 0, body: { message: failure === "connect" ? "connection to Hubtel failed" : "no response from Hubtel" }, failure }
  }
  const status = res.status
  try {
    const text = await res.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* keep text */ }
    return { status, body, failure: "none" }
  } catch {
    return { status, body: {}, failure: "body_read" }
  }
}

function toSendResult(status: number, body: unknown, failure: HubtelFailure): HubtelSendResult {
  const c = classifyHubtelResponse(status, body, failure)
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
  return toSendResult(r.status, r.body, r.failure)
}

export async function hubtelSendBatchSimple(cfg: HubtelConfig, m: { from: string; recipients: string[]; content: string }): Promise<HubtelSendResult> {
  const r = await call(cfg, "POST", "/v1/messages/batch/simple/send", { From: m.from, Recipients: m.recipients.map(toHubtelMsisdn), Content: m.content })
  return toSendResult(r.status, r.body, r.failure)
}

export async function hubtelSendBatchPersonalized(cfg: HubtelConfig, m: { from: string; items: { to: string; content: string }[] }): Promise<HubtelSendResult> {
  const r = await call(cfg, "POST", "/v1/messages/batch/personalized/send", {
    From: m.from,
    personalizedRecipients: m.items.map((i) => ({ To: toHubtelMsisdn(i.to), Content: i.content })),
  })
  return toSendResult(r.status, r.body, r.failure)
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

function statusError(r: { status: number; failure: HubtelFailure }): string | null {
  if (r.failure !== "none") return `Hubtel ${r.failure} failure`
  if (r.status < 200 || r.status >= 300) return `Hubtel HTTP ${r.status}`
  return null
}

export async function hubtelGetBatchStatus(cfg: HubtelConfig, batchId: string): Promise<HubtelStatusResult> {
  const r = await call(cfg, "GET", `/v1/messages/batch/${encodeURIComponent(batchId)}`)
  const err = statusError(r)
  if (err) return { ok: false, error: err, messages: [] }
  const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>
  const data = Array.isArray(b.data) ? (b.data as Record<string, unknown>[]) : []
  return { ok: true, messages: data.map(toEntry).filter((e): e is HubtelStatusEntry => e !== null) }
}

export async function hubtelGetMessageStatus(cfg: HubtelConfig, messageId: string): Promise<HubtelStatusResult> {
  const r = await call(cfg, "GET", `/v1/messages/${encodeURIComponent(messageId)}`)
  const err = statusError(r)
  if (err) return { ok: false, error: err, messages: [] }
  const e = toEntry((r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>)
  return { ok: true, messages: e ? [e] : [] }
}
