import { HubtelNotConfiguredError } from "./errors"
import type { HubtelCsMode } from "./config"

export type TransportResult = { httpStatus: number; body: unknown } | { error: string }

export interface HubtelCsTransport {
  call(req: { method: "GET" | "POST"; serviceId: string; query?: Record<string, string>; body?: unknown }): Promise<TransportResult>
}

const TIMEOUT_MS = 10_000

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

const qs = (q?: Record<string, string>) => (q && Object.keys(q).length ? `?${new URLSearchParams(q).toString()}` : "")

export function createDirectTransport(o: {
  disbursementAccount: string; basicAuth: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number
}): HubtelCsTransport {
  const doFetch = o.fetchImpl ?? fetch
  const base = (o.baseUrl ?? "https://cs.hubtel.com/commissionservices").replace(/\/$/, "")
  return {
    async call(req) {
      const url = `${base}/${encodeURIComponent(o.disbursementAccount)}/${req.serviceId}${qs(req.query)}`
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers: { Authorization: `Basic ${o.basicAuth}`, Accept: "application/json", "Content-Type": "application/json" },
          ...(req.method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
          signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
        })
        return { httpStatus: res.status, body: await readBody(res) }
      } catch (e: any) {
        return { error: String(e?.message ?? e) }
      }
    },
  }
}

export function createRelayTransport(o: { relayUrl: string; relaySecret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): HubtelCsTransport {
  const doFetch = o.fetchImpl ?? fetch
  const base = o.relayUrl.replace(/\/$/, "")
  return {
    async call(req) {
      const url = `${base}/cs/${req.serviceId}${qs(req.query)}`
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers: { Authorization: `Bearer ${o.relaySecret}`, "Content-Type": "application/json" },
          ...(req.method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
          signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
        })
        const json: any = await readBody(res)
        if (!res.ok || !json || typeof json !== "object" || !("upstreamStatus" in json)) return { error: `relay ${res.status}` }
        if (json.upstreamStatus === 0) return { error: String(json.body ?? "relay could not reach Hubtel") }
        return { httpStatus: json.upstreamStatus, body: json.body }
      } catch (e: any) {
        return { error: String(e?.message ?? e) }
      }
    },
  }
}

export function transportFromEnv(
  mode: HubtelCsMode,
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch
): HubtelCsTransport {
  if (mode === "relay") {
    const missing = ["HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET"].filter(k => !env[k])
    if (missing.length) throw new HubtelNotConfiguredError(missing)
    return createRelayTransport({ relayUrl: env.HUBTEL_RELAY_URL!, relaySecret: env.HUBTEL_RELAY_SECRET!, fetchImpl })
  }
  const missing = ["HUBTEL_CS_BASIC_AUTH", "HUBTEL_DISBURSEMENT_ACCOUNT"].filter(k => !env[k])
  if (missing.length) throw new HubtelNotConfiguredError(missing)
  return createDirectTransport({ disbursementAccount: env.HUBTEL_DISBURSEMENT_ACCOUNT!, basicAuth: env.HUBTEL_CS_BASIC_AUTH!, fetchImpl })
}
