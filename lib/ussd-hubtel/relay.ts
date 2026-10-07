// lib/ussd-hubtel/relay.ts
// Vercel-side client for the DO relay. Never calls Hubtel directly.
function relayConfig(): { url: string; secret: string } | null {
  const url = process.env.HUBTEL_RELAY_URL
  const secret = process.env.HUBTEL_RELAY_SECRET
  return url && secret ? { url: url.replace(/\/$/, ""), secret } : null
}

export type HubtelServiceStatus = "success" | "failed"

export interface CallbackParams {
  sessionId: string
  orderId: string
  /** Defaults to "success" when omitted. dispatchCallback sets it from the transaction's state. */
  serviceStatus?: HubtelServiceStatus
}

/** The callback body Hubtel receives (via the relay). Also what the callback log records. */
export function buildCallbackPayload(p: CallbackParams) {
  return { SessionId: p.sessionId, OrderId: p.orderId, ServiceStatus: p.serviceStatus ?? "success", MetaData: null }
}

export interface FulfillmentCallbackResult {
  ok: boolean
  error?: string
  /** Hubtel's HTTP status as reported by the relay (or the relay's own status if it refused). */
  upstreamStatus?: number
  /** Hubtel's response body as reported by the relay (or the relay's own JSON if it refused). */
  upstreamBody?: unknown
}

export async function sendFulfillmentCallback(p: CallbackParams): Promise<FulfillmentCallbackResult> {
  const cfg = relayConfig()
  if (!cfg) return { ok: false, error: "relay not configured" }
  try {
    const res = await fetch(`${cfg.url}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify(buildCallbackPayload(p)),
      signal: AbortSignal.timeout(10_000),
    })
    const json: any = await res.json().catch(() => null)
    const upstreamStatus: number = typeof json?.upstreamStatus === "number" ? json.upstreamStatus : res.status
    const upstreamBody: unknown = json && typeof json === "object" && "body" in json ? json.body : json
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        error: `relay/hubtel ${json?.upstreamStatus ?? res.status}: ${JSON.stringify(json?.body ?? null).slice(0, 200)}`,
        upstreamStatus, upstreamBody,
      }
    }
    return { ok: true, upstreamStatus, upstreamBody }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

export async function checkTransactionStatus(
  sessionId: string
): Promise<{ ok: boolean; status?: string; data?: any; error?: string }> {
  const cfg = relayConfig()
  if (!cfg) return { ok: false, error: "relay not configured" }
  try {
    const res = await fetch(`${cfg.url}/status?clientReference=${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(10_000),
    })
    const json: any = await res.json().catch(() => null)
    if (!res.ok || !json?.ok) return { ok: false, error: `relay/hubtel ${json?.upstreamStatus ?? res.status}` }
    const data = json.body?.data
    return { ok: true, status: data?.status, data }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
