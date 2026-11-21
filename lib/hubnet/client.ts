// Hubnet HTTP client. Env is read lazily from the injected env so tests can
// inject it. Deliberately no logging (key, webhook token and phones are secret/PII).
import { sendOrderRequest, type OrderRequestResult } from "@/lib/mtn-providers/outcome"
import { classifyStatusReply, normalizeRefunds, type HubnetNet, type HubnetRefundItem, type StatusLookup } from "./core"

const DEFAULT_BASE = "https://hubnet.app"
const TIMEOUT_MS = 30_000
const WEBHOOK_BASE = "https://www.datagod.store/api/webhooks/mtn/hubnet"

export type HubnetVerifyStatus = "verified" | "unverified" | "queued" | "invalid"

export interface HubnetClient {
  placeData(net: HubnetNet, b: { phone: string; volumeMb: number; reference: string }): Promise<OrderRequestResult>
  placeAirtime(b: { phone: string; amountGhs: number; reference: string }): Promise<OrderRequestResult>
  getStatus(reference: string): Promise<StatusLookup>
  listRefunds(): Promise<HubnetRefundItem[] | null>
  getBalance(): Promise<number | null>
  verifyMtn(number: string): Promise<HubnetVerifyStatus | null>
}

export function isHubnetConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.HUBNET_API_KEY?.trim()
}

export function hubnetWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = env.HUBNET_WEBHOOK_TOKEN
  return t && t.trim() ? `${WEBHOOK_BASE}?t=${encodeURIComponent(t)}` : undefined
}

const VERIFY_STATUSES: readonly string[] = ["verified", "unverified", "queued", "invalid"]

export function createHubnetClient(opts: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): HubnetClient {
  const doFetch: typeof fetch = opts.fetch ?? ((...a) => fetch(...a))
  const envOf = () => opts.env ?? process.env

  const url = (path: string) => {
    const mode = envOf().HUBNET_MODE === "test" ? "test" : "live"
    const base = (envOf().HUBNET_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "")
    return `${base}/${mode}/api/context/business/transaction/${path}`
  }
  const headers = (json: boolean): Record<string, string> => {
    const h: Record<string, string> = { token: `Bearer ${envOf().HUBNET_API_KEY ?? ""}` }
    if (json) h["Content-Type"] = "application/json"
    return h
  }
  const post = (path: string, body: Record<string, unknown>) =>
    doFetch(url(path), {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  const get = (path: string) =>
    doFetch(url(path), { method: "GET", headers: headers(false), signal: AbortSignal.timeout(TIMEOUT_MS) })

  const withWebhook = (body: Record<string, unknown>) => {
    const w = hubnetWebhookUrl(envOf())
    return w ? { ...body, webhook: w } : body
  }

  async function readJson(res: Response): Promise<unknown> {
    try {
      return JSON.parse(await res.text())
    } catch {
      return undefined
    }
  }

  return {
    placeData(net, b) {
      return sendOrderRequest("Hubnet", () =>
        post(`${net}-new-transaction`, withWebhook({ phone: b.phone, volume: String(b.volumeMb), reference: b.reference }))
      )
    },
    placeAirtime(b) {
      return sendOrderRequest("Hubnet", () =>
        post("airtime-new-transaction", withWebhook({ phone: b.phone, volume: b.amountGhs.toFixed(2), reference: b.reference }))
      )
    },
    async getStatus(reference) {
      try {
        const res = await get(`check-transaction-status?reference=${encodeURIComponent(reference)}`)
        const json = await readJson(res)
        return json === undefined ? { kind: "unknown" } : classifyStatusReply(res.status, json)
      } catch {
        return { kind: "unknown" }
      }
    },
    async listRefunds() {
      try {
        const res = await get("refunds")
        if (res.status < 200 || res.status >= 300) return null
        const json = await readJson(res)
        return json === undefined ? null : normalizeRefunds(json)
      } catch {
        return null
      }
    },
    async getBalance() {
      try {
        const res = await get("check_balance")
        if (res.status < 200 || res.status >= 300) return null
        const json = (await readJson(res)) as { data?: { wallet_balance?: unknown } } | undefined
        const n = Number(json?.data?.wallet_balance)
        return json?.data?.wallet_balance != null && Number.isFinite(n) ? n : null
      } catch {
        return null
      }
    },
    async verifyMtn(number) {
      try {
        const res = await get(`mtn-verification?number=${encodeURIComponent(number)}`)
        if (res.status < 200 || res.status >= 300) return null
        const json = (await readJson(res)) as { data?: { status?: unknown } } | undefined
        const s = json?.data?.status
        return typeof s === "string" && VERIFY_STATUSES.includes(s) ? (s as HubnetVerifyStatus) : null
      } catch {
        return null
      }
    },
  }
}
