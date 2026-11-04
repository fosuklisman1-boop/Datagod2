// lib/ussd-hubtel/relay-handler.ts
// Pure request handler for the DigitalOcean relay. No business logic, no queue.
// It exists so Hubtel sees a fixed (whitelisted) source IP for its outbound calls.
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
  /** Host (e.g. "www.datagod.store") every payment callbackUrl must point at. Unset → /receive and /checkout answer 501. */
  appHost?: string
  /** Basic credential for Receive Money + Online Checkout; defaults to statusBasicAuth. */
  receiveBasicAuth?: string
  receiveBaseUrl?: string
  checkoutBaseUrl?: string
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

// Payment routes (/receive, /checkout)
const PAY_REF = /^[0-9a-f]{32}$/
const PAY_MSISDN = /^233[0-9]{9}$/
const PAY_CHANNELS = new Set(["mtn-gh", "vodafone-gh", "tigo-gh"])
const PAY_DESCRIPTION = /^[A-Za-z0-9 .,-]{1,60}$/
const PAY_URL_MAX = 500

/**
 * Error codes that mean the request never left the relay: name resolution, TCP connect and
 * TLS handshake failures. Node's fetch (undici) throws TypeError("fetch failed") with the
 * system/undici error as `cause` (sometimes nested one level deeper). Anything not listed —
 * a timeout/abort (Hubtel may already have the request), ECONNRESET, a socket error mid-flight,
 * or an unrecognised shape — counts as sent, the safe side (no fallback to another provider).
 */
const PRE_SEND_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
])

function failedBeforeSend(e: unknown): boolean {
  let cur: any = e
  for (let depth = 0; depth < 3 && cur && typeof cur === "object"; depth++) {
    if (cur.name === "TimeoutError" || cur.name === "AbortError") return false
    if (typeof cur.code === "string" && PRE_SEND_CODES.has(cur.code)) return true
    cur = cur.cause
  }
  return false
}

function validAmount(v: unknown): v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0.1 || v > 10000) return false
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6
}

function httpsUrl(v: unknown): URL | null {
  if (typeof v !== "string" || v.length > PAY_URL_MAX) return null
  try {
    const u = new URL(v)
    if (u.protocol !== "https:" || u.username || u.password) return null
    return u
  } catch { return null }
}

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
  const receiveBase = (cfg.receiveBaseUrl ?? "https://rmp.hubtel.com").replace(/\/$/, "")
  const checkoutBase = (cfg.checkoutBaseUrl ?? "https://payproxyapi.hubtel.com").replace(/\/$/, "")
  const appHost = cfg.appHost?.trim().toLowerCase() || ""

  /** Shared send for /receive and /checkout: adds `sent` to the usual reply shape. */
  async function sendPayment(url: string, payload: Record<string, unknown>) {
    let responded = false
    let upstreamStatus = 0
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${cfg.receiveBasicAuth ?? cfg.statusBasicAuth}`,
          Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-cache",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      responded = true
      upstreamStatus = res.status
      return { status: 200, body: { ok: res.ok, upstreamStatus, body: await readBody(res), sent: true } }
    } catch (e: any) {
      // A response arrived but its body could not be read: Hubtel has the request.
      const sent = responded || !failedBeforeSend(e)
      return { status: 200, body: { ok: false, upstreamStatus, body: String(e?.message ?? e), sent } }
    }
  }

  /** Validates the fields common to both payment routes; returns an error string or null. */
  function commonPaymentError(p: any): string | null {
    if (typeof p?.reference !== "string" || !PAY_REF.test(p.reference)) return "invalid reference"
    if (!validAmount(p.amount)) return "invalid amount"
    if (typeof p.description !== "string" || !PAY_DESCRIPTION.test(p.description)) return "invalid description"
    const cb = httpsUrl(p.callbackUrl)
    if (!cb || cb.host !== appHost) return "invalid callbackUrl"
    return null
  }

  function parseObject(body: string): any | null {
    try {
      const v = JSON.parse(body)
      return v && typeof v === "object" && !Array.isArray(v) ? v : null
    } catch { return null }
  }

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

    if (req.method === "POST" && req.path === "/receive") {
      if (!appHost) return { status: 501, body: { error: "payments not configured" } }
      const p = parseObject(req.body)
      if (!p) return { status: 400, body: { error: "json object required" } }
      const err = commonPaymentError(p)
      if (err) return { status: 400, body: { error: err } }
      if (typeof p.msisdn !== "string" || !PAY_MSISDN.test(p.msisdn)) return { status: 400, body: { error: "invalid msisdn" } }
      if (typeof p.channel !== "string" || !PAY_CHANNELS.has(p.channel)) return { status: 400, body: { error: "invalid channel" } }
      const url = `${receiveBase}/merchantaccount/merchants/${encodeURIComponent(cfg.collectionAccount)}/receive/mobilemoney`
      // Field casing per the docs' parameter table (the sample shows "PrimaryCallbackUrl").
      return sendPayment(url, {
        CustomerMsisdn: p.msisdn, Channel: p.channel, Amount: p.amount,
        PrimaryCallbackURL: p.callbackUrl, Description: p.description, ClientReference: p.reference,
      })
    }

    if (req.method === "POST" && req.path === "/checkout") {
      if (!appHost) return { status: 501, body: { error: "payments not configured" } }
      const p = parseObject(req.body)
      if (!p) return { status: 400, body: { error: "json object required" } }
      const err = commonPaymentError(p)
      if (err) return { status: 400, body: { error: err } }
      if (!httpsUrl(p.returnUrl)) return { status: 400, body: { error: "invalid returnUrl" } }
      if (!httpsUrl(p.cancellationUrl)) return { status: 400, body: { error: "invalid cancellationUrl" } }
      return sendPayment(`${checkoutBase}/items/initiate`, {
        totalAmount: p.amount, description: p.description, callbackUrl: p.callbackUrl,
        returnUrl: p.returnUrl, cancellationUrl: p.cancellationUrl,
        merchantAccountNumber: cfg.collectionAccount, clientReference: p.reference,
      })
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
