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
  /** Basic credential for Direct Send Money (/send, /send-status); defaults to statusBasicAuth. */
  sendBasicAuth?: string
  sendBaseUrl?: string
  sendStatusBaseUrl?: string
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
/** Refund payouts (/send): the only callback path the relay will hand to Hubtel. */
const SEND_CALLBACK_PATH = "/api/webhooks/hubtel-send"
/** Fixed text: no surface or product word ever goes into a payout. */
const SEND_DESCRIPTION = "Refund"

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

export function failedBeforeSend(e: unknown): boolean {
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
  // Strict: the value must already be the 2-decimal double (0.1 + 0.2 is rejected; callers round).
  return Math.round(v * 100) / 100 === v
}

/** Parsed https URL on `host`, ≤500 chars before and after normalisation, no credentials. */
function appUrl(v: unknown, host: string): URL | null {
  if (typeof v !== "string" || v.length > PAY_URL_MAX) return null
  try {
    const u = new URL(v)
    if (u.protocol !== "https:" || u.username || u.password || u.host !== host) return null
    if (u.href.length > PAY_URL_MAX) return null
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
  const sendBase = (cfg.sendBaseUrl ?? "https://smp.hubtel.com").replace(/\/$/, "")
  const sendStatusBase = (cfg.sendStatusBaseUrl ?? "https://smrsc.hubtel.com").replace(/\/$/, "")

  /** Shared send for /receive, /checkout and /send: adds `sent` to the usual reply shape. */
  async function sendPayment(url: string, payload: Record<string, unknown>, basicAuth: string = cfg.receiveBasicAuth ?? cfg.statusBasicAuth) {
    let responded = false
    let upstreamStatus = 0
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-cache",
        },
        body: JSON.stringify(payload),
        // Never follow a redirect with the credential. A redirect rejects ("unexpected redirect",
        // no pre-send code), so it is classified sent:true: Hubtel may have acted on it.
        redirect: "error",
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

  /** Validates the fields common to both payment routes. Returns the normalised callback href. */
  function checkCommon(p: any): { error: string } | { callbackHref: string } {
    if (typeof p?.reference !== "string" || !PAY_REF.test(p.reference)) return { error: "invalid reference" }
    if (!validAmount(p.amount)) return { error: "invalid amount" }
    if (typeof p.description !== "string" || !PAY_DESCRIPTION.test(p.description)) return { error: "invalid description" }
    const cb = appUrl(p.callbackUrl, appHost)
    if (!cb) return { error: "invalid callbackUrl" }
    return { callbackHref: cb.href }
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
      const c = checkCommon(p)
      if ("error" in c) return { status: 400, body: { error: c.error } }
      if (typeof p.msisdn !== "string" || !PAY_MSISDN.test(p.msisdn)) return { status: 400, body: { error: "invalid msisdn" } }
      if (typeof p.channel !== "string" || !PAY_CHANNELS.has(p.channel)) return { status: 400, body: { error: "invalid channel" } }
      const url = `${receiveBase}/merchantaccount/merchants/${encodeURIComponent(cfg.collectionAccount)}/receive/mobilemoney`
      // Field casing per the docs' parameter table (the sample shows "PrimaryCallbackUrl").
      return sendPayment(url, {
        CustomerMsisdn: p.msisdn, Channel: p.channel, Amount: p.amount,
        PrimaryCallbackURL: c.callbackHref, Description: p.description, ClientReference: p.reference,
      })
    }

    if (req.method === "POST" && req.path === "/checkout") {
      if (!appHost) return { status: 501, body: { error: "payments not configured" } }
      const p = parseObject(req.body)
      if (!p) return { status: 400, body: { error: "json object required" } }
      const c = checkCommon(p)
      if ("error" in c) return { status: 400, body: { error: c.error } }
      const ret = appUrl(p.returnUrl, appHost)
      if (!ret) return { status: 400, body: { error: "invalid returnUrl" } }
      const cancel = appUrl(p.cancellationUrl, appHost)
      if (!cancel) return { status: 400, body: { error: "invalid cancellationUrl" } }
      return sendPayment(`${checkoutBase}/items/initiate`, {
        totalAmount: p.amount, description: p.description, callbackUrl: c.callbackHref,
        returnUrl: ret.href, cancellationUrl: cancel.href,
        merchantAccountNumber: cfg.collectionAccount, clientReference: p.reference,
      })
    }

    // Direct Send Money (refund payouts). Fixed Hubtel paths only, from the disbursement account.
    if (req.method === "POST" && req.path === "/send") {
      if (!appHost || !cfg.disbursementAccount) return { status: 501, body: { error: "send not configured" } }
      const p = parseObject(req.body)
      if (!p) return { status: 400, body: { error: "json object required" } }
      if (typeof p.reference !== "string" || !PAY_REF.test(p.reference)) return { status: 400, body: { error: "invalid reference" } }
      if (typeof p.msisdn !== "string" || !PAY_MSISDN.test(p.msisdn)) return { status: 400, body: { error: "invalid msisdn" } }
      if (typeof p.channel !== "string" || !PAY_CHANNELS.has(p.channel)) return { status: 400, body: { error: "invalid channel" } }
      if (!validAmount(p.amount)) return { status: 400, body: { error: "invalid amount" } }
      const cb = appUrl(p.callbackUrl, appHost)
      if (!cb || cb.pathname !== SEND_CALLBACK_PATH) return { status: 400, body: { error: "invalid callbackUrl" } }
      const url = `${sendBase}/api/merchants/${encodeURIComponent(cfg.disbursementAccount)}/send/mobilemoney`
      return sendPayment(url, {
        RecipientName: p.msisdn, RecipientMsisdn: p.msisdn, Channel: p.channel, Amount: p.amount,
        PrimaryCallbackURL: cb.href, Description: SEND_DESCRIPTION, ClientReference: p.reference,
      }, cfg.sendBasicAuth ?? cfg.statusBasicAuth)
    }

    if (req.method === "GET" && req.path === "/send-status") {
      if (!cfg.disbursementAccount) return { status: 501, body: { error: "send not configured" } }
      const ref = req.query.get("clientReference") ?? ""
      if (!PAY_REF.test(ref)) return { status: 400, body: { error: "invalid clientReference" } }
      const url = `${sendStatusBase}/api/merchants/${encodeURIComponent(cfg.disbursementAccount)}/transactions/status?clientReference=${ref}`
      try {
        const res = await doFetch(url, {
          method: "GET",
          headers: { Authorization: `Basic ${cfg.sendBasicAuth ?? cfg.statusBasicAuth}`, Accept: "application/json" },
          redirect: "error",
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
