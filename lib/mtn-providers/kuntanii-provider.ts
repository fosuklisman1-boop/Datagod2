// Kuntanii — MTN-only fulfillment provider (spec §2).
//
// Kuntanii is its own attempt ledger: attempt ids are <orderId>, <orderId>-r2
// .. -r5, and createOrder walks that chain with GET /orders/{id} before placing
// anything, so a re-send never double-delivers (only a cancelled attempt is
// ever replaced). Never logs the API key or a full phone number.

import crypto from "crypto"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { notifyAdminsThrottled } from "@/lib/sms/notify"
import {
  MAX_ATTEMPTS,
  aggregateOrdersStatus,
  attemptId,
  classifyKuntaniiError,
  existingAttemptAction,
  isSizeSupported,
  redactPhone,
  sumCost,
  toLocalGhanaPhone,
  type KuntaniiMode,
  type KuntaniiOrderEntry,
} from "./kuntanii-core"
import { createKuntaniiClient, getCachedPlans, type KuntaniiClient, type OrderBody } from "./kuntanii-client"

/** admin_settings key; value `{ mode: "normal" | "instant" }`. */
export const DELIVERY_MODE_KEY = "kuntanii_delivery_mode"

export async function getDeliveryMode(): Promise<KuntaniiMode> {
  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", DELIVERY_MODE_KEY)
      .maybeSingle()
    if (error) return "normal"
    return data?.value?.mode === "instant" ? "instant" : "normal"
  } catch {
    return "normal"
  }
}

/** Default admin alert: throttled once per `type` per hour, in the DB. Task 8 reuses it. */
export function defaultKuntaniiAlert(type: string, title: string, message: string): Promise<void> {
  return notifyAdminsThrottled(type, title, message, "/admin/settings/mtn", 3_600_000)
}

async function defaultRecordUnknownAttempt(externalOrderId: string, orderId?: string | null): Promise<void> {
  try {
    const { error } = await supabase
      .from("kuntanii_unknown_attempts")
      .upsert(
        { external_order_id: externalOrderId, order_id: orderId ?? null },
        { onConflict: "external_order_id", ignoreDuplicates: true },
      )
    if (error) console.warn(`[Kuntanii] could not record unknown attempt ${externalOrderId}: ${error.message}`)
  } catch (e) {
    console.warn(`[Kuntanii] could not record unknown attempt ${externalOrderId}:`, e instanceof Error ? e.message : e)
  }
}

export type KuntaniiDeps = {
  client?: KuntaniiClient
  getMode?: () => Promise<KuntaniiMode>
  alert?: (type: string, title: string, message: string) => Promise<void>
  recordUnknownAttempt?: (externalOrderId: string, orderId?: string | null) => Promise<void>
}

// ── Logging helpers ─────────────────────────────────────────────────────────

const PHONE_KEYS = new Set(["phoneNumber", "normalizedPhone"])

const PHONE_SHAPE = /^(0\d{9}|233\d{9})$/

function looksLikePhone(s: string): boolean {
  return PHONE_SHAPE.test(s.replace(/[\s\-+]/g, ""))
}

// Keyed redaction for phoneNumber/normalizedPhone, plus any phone-shaped string
// anywhere (e.g. bare arrays like removedNewNumbers, unknown keys).
function redactBody(value: unknown): unknown {
  if (typeof value === "string") return looksLikePhone(value) ? redactPhone(value.replace(/[\s\-+]/g, "")) : value
  if (Array.isArray(value)) return value.map(redactBody)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PHONE_KEYS.has(k) && (typeof v === "string" || typeof v === "number") ? redactPhone(String(v)) : redactBody(v)
    }
    return out
  }
  return value
}

/** Spec §12: raw response bodies (phones redacted) to verify undocumented fields. Remove after go-live. */
function logRaw(label: string, id: string, res: unknown): void {
  try {
    console.log(`[KUNTANII-RAW] ${label} ${id} ${JSON.stringify(redactBody(res))}`)
  } catch {
    /* logging must never affect the outcome */
  }
}

/** Order entries for status mapping: orders[] when non-empty, else the top-level status. */
export function entriesOf(body: OrderBody | undefined): KuntaniiOrderEntry[] {
  const orders = body?.orders
  if (Array.isArray(orders) && orders.length > 0) return orders
  if (typeof body?.status === "string") return [{ status: body.status }]
  // Nothing visible: [] maps to "resume"/"processing" — never place blind.
  return Array.isArray(orders) ? orders : [{ status: undefined }]
}

const KNOWN_STATUSES = new Set(["pending", "processing", "processed", "not received", "cancelled"])

function fail(error_type: string, message: string): MTNOrderResponse {
  return { success: false, error_type, message }
}

// ── Provider ────────────────────────────────────────────────────────────────

export class KuntaniiProvider implements MTNProvider {
  name = "kuntanii" as const

  private client: KuntaniiClient
  private getMode: () => Promise<KuntaniiMode>
  private alert: (type: string, title: string, message: string) => Promise<void>
  private recordUnknownAttempt: (externalOrderId: string, orderId?: string | null) => Promise<void>

  constructor(deps: KuntaniiDeps = {}) {
    this.client = deps.client ?? createKuntaniiClient()
    this.getMode = deps.getMode ?? getDeliveryMode
    this.alert = deps.alert ?? defaultKuntaniiAlert
    this.recordUnknownAttempt = deps.recordUnknownAttempt ?? defaultRecordUnknownAttempt
  }

  private async safeAlert(type: string, title: string, message: string): Promise<void> {
    try {
      await this.alert(type, title, message)
    } catch (e) {
      console.warn(`[Kuntanii] alert ${type} failed:`, e instanceof Error ? e.message : e)
    }
  }

  private async safeRecordUnknown(id: string, orderId: string | null): Promise<void> {
    try {
      await this.recordUnknownAttempt(id, orderId)
    } catch (e) {
      console.warn(`[Kuntanii] recordUnknownAttempt ${id} failed:`, e instanceof Error ? e.message : e)
    }
  }

  async createOrder(req: MTNOrderRequest): Promise<MTNOrderResponse> {
    // 1. MTN only; local-format phone with an MTN prefix. No network call on this path.
    if (req.network !== "MTN") return fail("VALIDATION", `Kuntanii is MTN-only (got ${req.network})`)
    const phone = toLocalGhanaPhone(req.recipient_phone)
    if (!phone || !validatePhoneNetworkMatch(phone, "MTN")) {
      return fail("VALIDATION", "Invalid MTN phone number")
    }

    // 2. Walk the attempt chain. Kuntanii is the ledger; never place blind.
    const base =
      req.client_ref ??
      (() => {
        console.warn("[Kuntanii] createOrder called with no client_ref — generating a random UUID (re-sends cannot be matched)")
        return crypto.randomUUID()
      })()

    let id: string | null = null
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const candidate = attemptId(base, n)
      let res: Awaited<ReturnType<KuntaniiClient["getOrder"]>>
      try {
        res = await this.client.getOrder(candidate)
      } catch (e) {
        console.warn(`[Kuntanii] attempt lookup ${candidate} threw:`, e instanceof Error ? e.message : e)
        return fail("RETRYABLE", "Kuntanii attempt lookup failed")
      }
      if (!res.ok) {
        // Only Kuntanii's own "order not found" frees the id; any other 404
        // (wrong route, proxy page) is an unknown — never place blind.
        if (res.status === 404 && !res.network && (res.code === undefined || res.code === "NOT_FOUND")) {
          id = candidate
          break
        }
        console.warn(`[Kuntanii] attempt lookup ${candidate} failed: HTTP ${res.status} ${res.code ?? ""}`)
        // ACCOUNT_HOLD classification does not depend on the delivery mode.
        if (!res.network && classifyKuntaniiError(res.status, res.code, "normal") === "ACCOUNT_HOLD") {
          const code = res.code ?? "ACCOUNT_HOLD"
          await this.safeAlert("kuntanii_" + code.toLowerCase(), "Kuntanii: orders refused", `${code}: ${res.message}`)
          return fail("ACCOUNT_HOLD", `Kuntanii attempt lookup refused (HTTP ${res.status}${res.code ? ` ${res.code}` : ""})`)
        }
        return fail("RETRYABLE", `Kuntanii attempt lookup failed (HTTP ${res.status})`)
      }
      const entries = entriesOf(res.data)
      if (existingAttemptAction(entries) === "resume") {
        const agg = aggregateOrdersStatus(entries)
        if (agg === "completed") {
          console.warn(`[Kuntanii] attempt ${candidate} already delivered — resuming it, NOT re-delivering`)
        } else {
          console.log(`[Kuntanii] attempt ${candidate} is live (${agg}) — resuming, no new order placed`)
        }
        return { success: true, order_id: candidate, message: `Existing Kuntanii attempt ${candidate} resumed (no new order placed)` }
      }
      // "next": every entry cancelled — try the next suffix.
    }
    if (!id) return fail("API_ERROR", "Kuntanii attempt cap reached")

    // 3. Size check against the live plan list for this mode (fail open if pricing is down).
    const mode = await this.getMode()
    let plans: Awaited<ReturnType<typeof getCachedPlans>> = null
    try {
      plans = await getCachedPlans(this.client, mode)
    } catch {
      plans = null
    }
    if (plans && !isSizeSupported(plans, req.size_gb)) {
      return fail("UNSUPPORTED_SIZE", `Kuntanii has no ${req.size_gb}GB plan in ${mode} mode`)
    }

    // 4. Beneficiary pre-check (fail open on error).
    try {
      const v = await this.client.verifyBeneficiaries([phone])
      if (v.ok && v.data?.results?.[0]?.eligible === false) {
        return fail("NOT_ELIGIBLE", `Kuntanii: ${v.data.results[0].reason}`)
      }
    } catch {
      /* fail open */
    }

    // 5. Place. The client already retried once with the identical body + key.
    let res: Awaited<ReturnType<KuntaniiClient["placeOrder"]>>
    try {
      res = await this.client.placeOrder({ externalOrderId: id, phoneNumber: phone, dataGb: req.size_gb, mode })
    } catch (e) {
      res = { ok: false, status: 0, network: true, message: e instanceof Error ? e.message : "network error" }
    }
    logRaw("place", id, res)

    if (res.ok) {
      const body = res.data
      const idempotent = body?.idempotent === true
      if (idempotent && aggregateOrdersStatus(entriesOf(body)) === "failed") {
        return fail("API_ERROR", `Kuntanii replayed order ${id} and it is cancelled`)
      }
      if (body?.acceptedCount === 0) {
        return fail("NOT_ELIGIBLE", "Kuntanii accepted no recipients")
      }
      return {
        success: true,
        order_id: id,
        message: idempotent ? "Order already placed (idempotent replay)" : "Order placed with Kuntanii",
        provider_cost_ghs: idempotent ? undefined : sumCost(body?.orders, body?.totalAmountGhs),
        provider_reference: body?.orderReference ?? body?.orders?.find((o) => o.orderReference)?.orderReference,
      }
    }

    // Unknown outcome (timeout / unparseable 2xx): ask Kuntanii once whether it exists.
    if (res.network === true || (res.status >= 200 && res.status < 300)) {
      let found = false
      let cancelled = false
      try {
        const check = await this.client.getOrder(id)
        if (check.ok) {
          if (aggregateOrdersStatus(entriesOf(check.data)) === "failed") cancelled = true
          else found = true
        }
      } catch {
        found = false
      }
      if (cancelled) {
        // Kuntanii has it and it is cancelled: nothing will be delivered, safe to fail over.
        return fail("API_ERROR", `Kuntanii order ${id} exists but is cancelled (after unknown outcome)`)
      }
      if (found) {
        console.warn(`[Kuntanii] place ${id} had an unknown outcome but the order exists — treating as accepted`)
        return { success: true, order_id: id, message: "accepted (reconciled after unknown outcome)" }
      }
      await this.safeRecordUnknown(id, req.client_ref ?? null)
      return fail("RETRYABLE", `Kuntanii outcome unknown: ${res.message}`)
    }

    const cls = classifyKuntaniiError(res.status, res.code, mode)
    if (cls === "ACCOUNT_HOLD" || cls === "INSTANT_UNAVAILABLE") {
      await this.safeAlert(
        "kuntanii_" + (res.code ?? cls).toLowerCase(),
        "Kuntanii: orders refused",
        `${res.code ?? cls}: ${res.message}`,
      )
    }
    // RETRYABLE: outcome unknown. CONFLICT: an order with this id exists — both must be watched.
    if (cls === "RETRYABLE" || cls === "CONFLICT") await this.safeRecordUnknown(id, req.client_ref ?? null)
    if (cls === "CONFLICT") console.error(`[Kuntanii] CONFLICT placing ${id} — same id, different body? investigate`)
    return fail(cls, `Kuntanii ${res.status}${res.code ? ` ${res.code}` : ""}: ${res.message}`)
  }

  async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(orderId)
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to Kuntanii (local failure)" }
    }
    let res: Awaited<ReturnType<KuntaniiClient["getOrder"]>>
    try {
      res = await this.client.getOrder(id)
    } catch (e) {
      return { success: false, message: `Kuntanii status lookup failed: ${e instanceof Error ? e.message : "error"}` }
    }
    logRaw("status", id, res)
    if (!res.ok) {
      // 404 may be propagation lag — never mark failed from it.
      return { success: false, message: `Kuntanii status lookup failed (HTTP ${res.status})` }
    }
    const entries = entriesOf(res.data)
    for (const e of entries) {
      const s = (e.status ?? "").trim().toLowerCase()
      if (!KNOWN_STATUSES.has(s)) console.warn(`[Kuntanii] unknown status for ${id} (${e.orderReference ?? "no ref"}); treating as processing`)
    }
    const status = aggregateOrdersStatus(entries)
    // Redacted: callers (syncMTNOrderStatus) log this result. Redaction only rewrites
    // phone-shaped strings, so status / message / orderReference / notReceivedStatus survive.
    return { success: true, status, message: `Kuntanii status: ${status}`, order: redactBody(res.data) as OrderBody | undefined }
  }

  async checkBalance(): Promise<number | null> {
    // Credit account: Kuntanii exposes no balance to us.
    return null
  }
}

export default KuntaniiProvider
