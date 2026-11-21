// Pure Hubnet helpers (no I/O, no env).
// NOTE: the reply parsers (status / refunds) are PROVISIONAL, built from the
// provider docs' example bodies, pending the Task 1 live probe. Revisit once
// real response bodies are captured.
import { toLocalGhanaPhone } from "@/lib/mtn-providers/kuntanii-core"

export type HubnetKind = "data" | "airtime"
export const HUBNET_MAX_ATTEMPTS = 5

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reference: D{G|A} + first 22 hex of the uuid, plus R{n} for attempts 2..5. < 30 chars. */
export function hubnetRef(kind: HubnetKind, uuid: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > HUBNET_MAX_ATTEMPTS) {
    throw new Error(`hubnetRef: attempt out of range: ${attempt}`)
  }
  if (!UUID_RE.test(uuid)) throw new Error("hubnetRef: not a uuid")
  const hex22 = uuid.replace(/-/g, "").toLowerCase().slice(0, 22)
  return `${kind === "airtime" ? "DA" : "DG"}${hex22}${attempt > 1 ? `R${attempt}` : ""}`
}

export function parseHubnetRef(ref: string): { kind: HubnetKind; prefix22: string; attempt: number } | null {
  const m = /^D([GA])([0-9a-f]{22})(?:R([2-5]))?$/.exec(String(ref ?? ""))
  if (!m) return null
  return { kind: m[1] === "A" ? "airtime" : "data", prefix22: m[2], attempt: m[3] ? Number(m[3]) : 1 }
}

export type HubnetNet = "mtn" | "at" | "big-time" | "telecel"

export function endpointFor(network: "MTN" | "Telecel" | "AirtelTigo", isBigTime = false): HubnetNet {
  if (network === "MTN") return "mtn"
  if (network === "Telecel") return "telecel"
  return isBigTime ? "big-time" : "at"
}

export function toHubnetPhone(raw: string): string | null {
  return toLocalGhanaPhone(raw)
}

export type HubnetStatus = "processing" | "completed" | "failed"

export function mapHubnetStatus(raw: string | null | undefined): HubnetStatus {
  const w = String(raw ?? "").trim().toLowerCase()
  if (["success", "completed", "delivered"].includes(w)) return "completed"
  if (["failed", "refunded", "reversed", "cancelled"].includes(w)) return "failed"
  return "processing"
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const STATUS_KEYS = ["status", "delivery_status", "transaction_status"] as const

/** Every candidate status word in a body (top level and `data`). */
function statusWords(body: unknown): string[] {
  if (!isObj(body)) return []
  const out: string[] = []
  for (const src of [body, isObj(body.data) ? body.data : null]) {
    if (!src) continue
    for (const k of STATUS_KEYS) {
      const v = src[k]
      if (typeof v === "string" && v.trim()) out.push(v)
    }
  }
  return out
}

function primaryStatusWord(body: Record<string, unknown>): string | undefined {
  const pick = (src: Record<string, unknown>, keys: readonly string[]) => {
    for (const k of keys) {
      const v = src[k]
      if (typeof v === "string" && v.trim()) return v
    }
    return undefined
  }
  if (isObj(body.data)) {
    const nested = pick(body.data, ["delivery_status", "transaction_status", "status"])
    if (nested) return nested
  }
  return pick(body, ["delivery_status", "status"])
}

export function isHubnetRefunded(body: unknown): boolean {
  if (!isObj(body)) return false
  if (body.refunded === true) return true
  if (isObj(body.data) && body.data.refunded === true) return true
  return statusWords(body).some((w) => ["refunded", "reversed"].includes(w.trim().toLowerCase()))
}

export type StatusLookup =
  | { kind: "found"; status: HubnetStatus; refunded: boolean; raw: unknown; costGhs?: number }
  | { kind: "missing" }
  | { kind: "unknown" }

export function classifyStatusReply(httpStatus: number, body: unknown): StatusLookup {
  if (!isObj(body)) return { kind: "unknown" }
  if (httpStatus === 404) {
    const msg = typeof body.message === "string" ? body.message : ""
    return /transaction.*not\s*found|no\s+transaction|invalid reference/i.test(msg)
      ? { kind: "missing" }
      : { kind: "unknown" }
  }
  if (httpStatus < 200 || httpStatus >= 300) return { kind: "unknown" }
  const words = statusWords(body)
  if (words.length === 0) return { kind: "unknown" }
  const refunded = isHubnetRefunded(body)
  // Refund signal (anywhere) wins. Otherwise the nested data status is the
  // delivery state; a top-level word is only an API-call status, so it is used
  // only when data carries none. Never upgrade to completed from a lesser source.
  const status: HubnetStatus = refunded ? "failed" : mapHubnetStatus(primaryStatusWord(body))
  const result: StatusLookup = { kind: "found", status, refunded, raw: body }
  const amt = isObj(body.data) && body.data.amount !== undefined ? body.data.amount : body.amount
  const n = typeof amt === "string" && amt.trim() !== "" ? Number(amt) : amt
  if (typeof n === "number" && Number.isFinite(n)) result.costGhs = n
  return result
}

export type PlaceClass =
  | "success"
  | "duplicate"
  | "insufficient_balance"
  | "auth"
  | "rate_limited"
  | "rejected"
  | "unknown"

export function classifyPlaceReply(httpStatus: number, body: unknown): PlaceClass {
  if (!isObj(body)) return "unknown"
  if (httpStatus === 200) return body.event === "charge.success" ? "success" : "unknown"
  if (httpStatus === 409) return "duplicate"
  if (httpStatus === 401) return "auth"
  if (httpStatus === 429) return "rate_limited"
  if (httpStatus === 400 || httpStatus === 403) {
    const msg = typeof body.message === "string" ? body.message : ""
    if (httpStatus === 400 && (Number(body.status_code) === 402 || /insufficient/i.test(msg))) {
      return "insufficient_balance"
    }
    return "rejected"
  }
  return "unknown"
}

export type HubnetRefundItem = { reference?: string; phone?: string; volume?: string; amount?: number; date?: string }

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  return undefined
}

export function normalizeRefunds(body: unknown): HubnetRefundItem[] {
  let list: unknown = body
  if (isObj(body)) {
    const d = body.data
    list = Array.isArray(d) ? d : isObj(d) && Array.isArray(d.refunds) ? d.refunds : Array.isArray(body.refunds) ? body.refunds : null
  }
  if (!Array.isArray(list)) return []
  const out: HubnetRefundItem[] = []
  for (const it of list) {
    if (!isObj(it)) continue
    const item: HubnetRefundItem = {}
    const reference = str(it.reference) ?? str(it.batch_id) ?? str(it.transaction_id)
    const phone = str(it.phone) ?? str(it.number) ?? str(it.msisdn)
    const volume = str(it.volume)
    const date = str(it.date) ?? str(it.created_at)
    if (reference) item.reference = reference
    if (phone) item.phone = phone
    if (volume) item.volume = volume
    if (it.amount !== undefined && it.amount !== null && it.amount !== "") {
      const a = Number(it.amount)
      if (Number.isFinite(a)) item.amount = a
    }
    if (date) item.date = date
    out.push(item)
  }
  return out
}
