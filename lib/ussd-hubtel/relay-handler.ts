// lib/ussd-hubtel/relay-handler.ts
// Pure request handler for the DigitalOcean relay. No business logic, no queue.
// It exists so Hubtel sees a fixed (whitelisted) source IP for four outbound calls.
import crypto from "crypto"

export interface RelayConfig {
  secret: string
  collectionAccount: string
  statusBasicAuth: string // base64 "user:pass" credential, without the "Basic " prefix
  fetchImpl?: typeof fetch
  callbackUrl?: string
  statusBaseUrl?: string
  /** Hubtel Disbursement (prepaid) account number — SMS is paid from it. Optional. */
  disbursementAccount?: string
  /** Basic credential for the balance endpoint; defaults to statusBasicAuth. */
  balanceBasicAuth?: string
  balanceBaseUrl?: string
  /** Basic credential for Commission Services (cs.hubtel.com); required for the /cs passthrough. */
  csBasicAuth?: string
  csBaseUrl?: string
  /** Basic credential for the refund API; defaults to statusBasicAuth. */
  refundBasicAuth?: string
  refundBaseUrl?: string
}

export interface RelayRequest {
  method: string
  path: string
  query: URLSearchParams
  authorization: string | null
  body: string
}

const SAFE_REF = /^[A-Za-z0-9_-]{1,100}$/
const CS_PATH = /^\/cs\/([a-f0-9]{32})$/
const REFUND_ORDER_ID = /^[a-f0-9]{32}$/
const CS_QUERY_KEYS = ["destination", "mobile"] as const
const CS_QUERY_VALUE = /^[A-Za-z0-9+_-]{1,40}$/
/** Bounds each upstream call (headers + body), below the Vercel side's own timeout. */
const UPSTREAM_TIMEOUT_MS = 8000

function bearerOk(authorization: string | null, secret: string): boolean {
  if (!authorization?.startsWith("Bearer ") || !secret) return false
  const a = Buffer.from(authorization.slice(7))
  const b = Buffer.from(secret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

export function createRelayHandler(cfg: RelayConfig) {
  const doFetch = cfg.fetchImpl ?? fetch
  const callbackUrl = cfg.callbackUrl ?? "https://gs-callback.hubtel.com:9055/callback"
  const statusBase = cfg.statusBaseUrl ?? "https://api-txnstatus.hubtel.com"
  const balanceBase = cfg.balanceBaseUrl ?? "https://trnf.hubtel.com"
  const refundBase = (cfg.refundBaseUrl ?? "https://refund-api.hubtel.com").replace(/\/$/, "")
  const csBase = (cfg.csBaseUrl ?? "https://cs.hubtel.com/commissionservices").replace(/\/$/, "")

  return async function handle(req: RelayRequest): Promise<{ status: number; body: unknown }> {
    if (!bearerOk(req.authorization, cfg.secret)) return { status: 401, body: { error: "unauthorized" } }

    if (req.method === "POST" && req.path === "/callback") {
      let parsed: any
      try { parsed = JSON.parse(req.body) } catch { return { status: 400, body: { error: "invalid json" } } }
      if (typeof parsed?.SessionId !== "string" || typeof parsed?.OrderId !== "string") {
        return { status: 400, body: { error: "SessionId and OrderId required" } }
      }
      const payload = {
        SessionId: parsed.SessionId,
        OrderId: parsed.OrderId,
        ServiceStatus: parsed.ServiceStatus ?? "success",
        MetaData: parsed.MetaData ?? null,
      }
      try {
        const res = await doFetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "Cache-Control": "no-cache" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }

    if (req.method === "GET" && req.path === "/status") {
      const ref = req.query.get("clientReference") ?? ""
      if (!SAFE_REF.test(ref)) return { status: 400, body: { error: "invalid clientReference" } }
      const url = `${statusBase}/transactions/${encodeURIComponent(cfg.collectionAccount)}/status?clientReference=${encodeURIComponent(ref)}`
      try {
        const res = await doFetch(url, {
          method: "GET",
          headers: { Authorization: `Basic ${cfg.statusBasicAuth}` },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }

    if (req.method === "GET" && req.path === "/balance") {
      if (!cfg.disbursementAccount) return { status: 501, body: { error: "balance not configured" } }
      const url = `${balanceBase}/api/inter-transfers/prepaid/${encodeURIComponent(cfg.disbursementAccount)}`
      try {
        const res = await doFetch(url, {
          method: "GET",
          headers: {
            Authorization: `Basic ${cfg.balanceBasicAuth ?? cfg.statusBasicAuth}`,
            Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-cache",
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }

    if (req.method === "POST" && req.path === "/refund") {
      let parsed: any
      try { parsed = JSON.parse(req.body) } catch { return { status: 400, body: { error: "invalid json" } } }
      if (typeof parsed?.orderId !== "string" || !REFUND_ORDER_ID.test(parsed.orderId)) {
        return { status: 400, body: { error: "invalid orderId" } }
      }
      let httpsOk = false
      try {
        httpsOk = typeof parsed.callbackUrl === "string" && parsed.callbackUrl.length <= 500 &&
          new URL(parsed.callbackUrl).protocol === "https:"
      } catch { /* not a URL */ }
      if (!httpsOk) return { status: 400, body: { error: "invalid callbackUrl" } }
      const url = `${refundBase}/refund/${encodeURIComponent(cfg.collectionAccount)}/order/${parsed.orderId}`
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: {
            Authorization: `Basic ${cfg.refundBasicAuth ?? cfg.statusBasicAuth}`,
            Accept: "application/json", "Content-Type": "application/json",
          },
          body: JSON.stringify({ callbackUrl: parsed.callbackUrl }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }

    const cs = CS_PATH.exec(req.path)
    if (cs && (req.method === "GET" || req.method === "POST")) {
      if (!cfg.disbursementAccount || !cfg.csBasicAuth) return { status: 501, body: { error: "cs not configured" } }
      let url = `${csBase}/${encodeURIComponent(cfg.disbursementAccount)}/${cs[1]}`
      let body: string | undefined
      if (req.method === "GET") {
        const q = new URLSearchParams()
        for (const k of CS_QUERY_KEYS) {
          const v = req.query.get(k)
          if (v !== null) {
            if (!CS_QUERY_VALUE.test(v)) return { status: 400, body: { error: `invalid ${k}` } }
            q.set(k, v)
          }
        }
        if ([...q].length) url += `?${q.toString()}`
      } else {
        let parsed: unknown
        try { parsed = JSON.parse(req.body) } catch { return { status: 400, body: { error: "invalid json" } } }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400, body: { error: "json object required" } }
        body = JSON.stringify(parsed)
      }
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers: { Authorization: `Basic ${cfg.csBasicAuth}`, Accept: "application/json", "Content-Type": "application/json" },
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }

    return { status: 404, body: { error: "not found" } }
  }
}
