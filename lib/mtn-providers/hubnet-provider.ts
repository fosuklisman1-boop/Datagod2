// Hubnet fulfillment provider (data: MTN, AT iShare, AT BigTime, Telecel).
//
// Hubnet is its own attempt ledger. References are derived from our order uuid
// (client_ref) by hubnetRef(kind, uuid, n), n = 1..5. createOrder walks that chain
// with a status lookup BEFORE placing anything, so a re-send never double-delivers:
// only a failed / refunded attempt is ever replaced, and any ambiguity (unknown
// lookup, unreadable place reply) holds the order as OUTCOME_UNKNOWN instead of
// placing. Never logs the API key, webhook token or a phone number.

import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { notifyAdminsThrottled } from "@/lib/sms/notify"
import { createHubnetClient, isHubnetConfigured, type HubnetClient } from "@/lib/hubnet/client"
import {
  HUBNET_MAX_ATTEMPTS,
  classifyPlaceReply,
  endpointFor,
  hubnetRef,
  toHubnetPhone,
  type PlaceClass,
  type StatusLookup,
} from "@/lib/hubnet/core"
import { OUTCOME_UNKNOWN, isUnknownTrackingId, outcomeUnknownResponse, unknownStatusResult } from "./outcome"

/** Default admin alert: throttled once per `type` per hour, in the DB. */
export function defaultHubnetAlert(type: string, title: string, message: string): Promise<void> {
  return notifyAdminsThrottled(type, title, message, "/admin/settings/mtn", 3_600_000)
}

export type HubnetDeps = {
  client?: HubnetClient
  alert?: (type: string, title: string, message: string) => Promise<void>
  configured?: () => boolean
}

function fail(error_type: string, message: string, traceId?: string): MTNOrderResponse {
  return { success: false, error_type, message, ...(traceId ? { traceId } : {}) }
}

/** The raw delivery status word from a status body (nested data first), for external_status. */
function rawStatusWord(raw: unknown): string | undefined {
  const pick = (src: unknown): string | undefined => {
    if (!src || typeof src !== "object") return undefined
    const o = src as Record<string, unknown>
    for (const k of ["delivery_status", "transaction_status", "status"]) {
      const v = o[k]
      if (typeof v === "string" && v.trim()) return v
    }
    return undefined
  }
  const body = raw as { data?: unknown } | null
  return pick(body?.data) ?? pick(raw)
}

export class HubnetProvider implements MTNProvider {
  name = "hubnet" as const

  private client: HubnetClient | null
  private alert: (type: string, title: string, message: string) => Promise<void>
  private configured: () => boolean

  constructor(deps: HubnetDeps = {}) {
    // Lazy default client: constructing a provider (e.g. via the factory) must not need env.
    this.client = deps.client ?? null
    this.alert = deps.alert ?? defaultHubnetAlert
    this.configured = deps.configured ?? (() => isHubnetConfigured())
  }

  private get c(): HubnetClient {
    if (!this.client) this.client = createHubnetClient()
    return this.client
  }

  private async safeAlert(type: string, title: string, message: string): Promise<void> {
    try {
      await this.alert(type, title, message)
    } catch (e) {
      console.warn(`[Hubnet] alert ${type} failed:`, e instanceof Error ? e.message : e)
    }
  }

  private async lookup(ref: string): Promise<StatusLookup> {
    try {
      return await this.c.getStatus(ref)
    } catch {
      return { kind: "unknown" }
    }
  }

  async createOrder(req: MTNOrderRequest): Promise<MTNOrderResponse> {
    const traceId = req.traceId
    const uuid = req.client_ref
    // Never invent a reference: a random one could never be matched on a re-send.
    try {
      hubnetRef("data", String(uuid ?? ""), 1)
    } catch {
      return fail("API_ERROR", "Hubnet: no order reference", traceId)
    }
    if (!this.configured()) return fail("API_ERROR", "Hubnet not configured", traceId)

    const phone = toHubnetPhone(req.recipient_phone)
    if (!phone || !validatePhoneNetworkMatch(phone, req.network)) {
      return fail("VALIDATION", `Invalid ${req.network} phone number`, traceId)
    }
    const volumeMb = Math.round(req.size_gb * 1000)
    if (!Number.isFinite(volumeMb) || volumeMb <= 0) return fail("VALIDATION", "Invalid data size", traceId)
    const net = endpointFor(req.network, req.isBigTime === true)

    for (let n = 1; n <= HUBNET_MAX_ATTEMPTS; n++) {
      const ref = hubnetRef("data", uuid as string, n)
      const lk = await this.lookup(ref)
      if (lk.kind === "unknown") return outcomeUnknownResponse("Hubnet", null, traceId)
      if (lk.kind === "found") {
        if ((lk.status === "processing" || lk.status === "completed") && !lk.refunded) {
          return { success: true, order_id: ref, message: `Existing Hubnet attempt resumed (no new order placed)`, traceId }
        }
        continue // failed or refunded: next attempt
      }
      return this.place(net, phone, volumeMb, ref, traceId)
    }
    return fail("API_ERROR", `Hubnet: all ${HUBNET_MAX_ATTEMPTS} attempts used`, traceId)
  }

  private async place(
    net: ReturnType<typeof endpointFor>,
    phone: string,
    volumeMb: number,
    ref: string,
    traceId?: string,
  ): Promise<MTNOrderResponse> {
    let cls: PlaceClass
    try {
      const r = await this.c.placeData(net, { phone, volumeMb, reference: ref })
      if (!r.ok) {
        if (r.response.error_type !== OUTCOME_UNKNOWN) return r.response
        cls = "unknown"
      } else {
        cls = classifyPlaceReply(r.res.status, r.json)
      }
    } catch {
      cls = "unknown"
    }

    switch (cls) {
      case "success":
        return { success: true, order_id: ref, message: "Order placed with Hubnet", traceId }
      case "duplicate": {
        const lk = await this.lookup(ref)
        if (lk.kind === "found" && lk.status !== "failed" && !lk.refunded) {
          return { success: true, order_id: ref, message: "Existing Hubnet order adopted (duplicate reference)", traceId }
        }
        return outcomeUnknownResponse("Hubnet", null, traceId)
      }
      case "unknown": {
        const lk = await this.lookup(ref)
        if (lk.kind === "found") {
          if (lk.status !== "failed" && !lk.refunded) {
            return { success: true, order_id: ref, message: "accepted (reconciled after unknown outcome)", traceId }
          }
          return fail("API_ERROR", "Hubnet order exists but failed (after unknown outcome)", traceId)
        }
        return outcomeUnknownResponse("Hubnet", null, traceId)
      }
      case "insufficient_balance":
        await this.safeAlert(
          "hubnet_low_balance",
          "Hubnet: wallet balance too low",
          "Hubnet refused an order because the wallet balance is insufficient. Top up the Hubnet wallet.",
        )
        return fail("INSUFFICIENT_BALANCE", "Hubnet: insufficient balance", traceId)
      case "auth":
        await this.safeAlert(
          "hubnet_auth",
          "Hubnet: authentication failed",
          "Hubnet rejected our API credentials. Check HUBNET_API_KEY and the Hubnet account.",
        )
        return fail("API_ERROR", "Hubnet: authentication failed", traceId)
      case "rate_limited":
        return fail("API_ERROR", "Hubnet: rate limited", traceId)
      case "rejected":
      default:
        return fail("API_ERROR", "Hubnet: order rejected", traceId)
    }
  }

  async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(orderId)
    if (isUnknownTrackingId(id)) return unknownStatusResult()
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to Hubnet (local failure)" }
    }
    const lk = await this.lookup(id)
    if (lk.kind !== "found") {
      // missing may be propagation lag; unknown is unknown. Never infer a status.
      return { success: false, message: `Hubnet status lookup inconclusive (${lk.kind})` }
    }
    const rawWord = rawStatusWord(lk.raw)
    return {
      success: true,
      status: lk.status,
      message: `Hubnet status: ${lk.status}`,
      order: { status: lk.refunded ? "refunded" : (rawWord ?? lk.status), refunded: lk.refunded },
    }
  }

  async checkBalance(): Promise<number | null> {
    if (!this.configured()) return null
    try {
      return await this.c.getBalance()
    } catch {
      return null
    }
  }
}

export default HubnetProvider
