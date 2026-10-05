// lib/ussd-hubtel/relay-handler.ts
// Pure request handler for the DigitalOcean relay. No business logic, no queue.
// It exists so Hubtel sees a fixed (whitelisted) source IP for two outbound calls.
import crypto from "crypto"

export interface RelayConfig {
  secret: string
  collectionAccount: string
  statusBasicAuth: string // base64 "user:pass" credential, without the "Basic " prefix
  fetchImpl?: typeof fetch
  callbackUrl?: string
  statusBaseUrl?: string
}

export interface RelayRequest {
  method: string
  path: string
  query: URLSearchParams
  authorization: string | null
  body: string
}

const SAFE_REF = /^[A-Za-z0-9_-]{1,100}$/

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
        const res = await doFetch(url, { method: "GET", headers: { Authorization: `Basic ${cfg.statusBasicAuth}` } })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }

    return { status: 404, body: { error: "not found" } }
  }
}
