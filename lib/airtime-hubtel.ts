import { airtimeNetId } from "./airtime-provider"
import type { PurchaseInput } from "./hubtel-cs/client"
import {
  HubtelDuplicateOrderError, HubtelOutcomeUnknownError,
} from "./hubtel-cs/errors"
import type { HubtelCsServiceKey } from "./hubtel-cs/services"
import type { HubtelCsTx } from "./hubtel-cs/types"

export interface AirtimeOrderMinimal {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  airtime_amount: number
}

/** Hubtel's per-request airtime cap (docs: "maximum airtime top-up amount per request is 100 cedis"). */
export const HUBTEL_AIRTIME_MAX = 100

export interface AirtimeHubtelDeps {
  purchase(input: PurchaseInput): Promise<HubtelCsTx>
  /** When onlyFromStatuses is given the write MUST only apply to an order currently in one of those statuses. */
  markOrder(orderId: string, patch: { status?: string; notes: string }, onlyFromStatuses?: string[]): Promise<void>
  /** kind "review" = Hubtel outcome unknown / in review; "manual" (default) = not sent, fulfil manually. */
  alert(message: string, kind?: "manual" | "review"): Promise<void>
}

const quiet = async (p: Promise<void>, what: string) => {
  try { await p } catch (e: any) { console.error(`[AIRTIME-HUBTEL] ${what} failed:`, e?.message ?? e) }
}

/**
 * Hand a paid airtime order to Hubtel. Returns true when Hubtel owns it now (pending, settled, outcome
 * unknown, or a live Hubtel transaction already exists) and false when nothing was sent (manual needed).
 * Never resends, never falls back to another provider, never throws.
 */
export async function fulfillAirtimeViaHubtel(order: AirtimeOrderMinimal, deps: AirtimeHubtelDeps): Promise<boolean> {
  const tag = `${order.reference_code} (${order.network} ${order.beneficiary_phone} GHS ${order.airtime_amount})`
  const notSent = async (why: string) => {
    await quiet(deps.markOrder(order.id, { notes: `Hubtel: not sent - ${why}. Fulfil manually.` }), "markOrder")
    await quiet(deps.alert(`Airtime ${tag} needs manual fulfilment: Hubtel not sent - ${why}`), "alert")
    return false
  }

  const id = airtimeNetId(order.network)
  if (!id) return notSent(`unsupported network "${order.network}"`)
  if (!(order.airtime_amount <= HUBTEL_AIRTIME_MAX)) return notSent(`amount over the Hubtel limit of GHS ${HUBTEL_AIRTIME_MAX}`)

  try {
    const tx = await deps.purchase({
      serviceKey: `airtime_${id}` as HubtelCsServiceKey,
      destination: order.beneficiary_phone,
      amount: order.airtime_amount,
      orderTable: "airtime_orders",
      orderId: order.id,
    })
    if (tx.state === "needs_review") {
      await quiet(deps.markOrder(order.id, { status: "processing", notes: `Hubtel: outcome unknown, in review [hcsRef:${tx.client_reference}]. Do not resend.` }, ["pending"]), "markOrder")
      await quiet(deps.alert(`Airtime ${tag}: Hubtel outcome unknown (ref ${tx.client_reference}) - check the Hubtel review queue, do not resend`, "review"), "alert")
      return true
    }
    if (tx.state === "pending" || tx.state === "created") {
      await quiet(deps.markOrder(order.id, { status: "processing", notes: `Sent via Hubtel [hcsRef:${tx.client_reference}]` }, ["pending"]), "markOrder")
    }
    // fulfilled / failed were already applied to the order by the adapter hook.
    return tx.state !== "failed"
  } catch (e: any) {
    if (e instanceof HubtelDuplicateOrderError) return true
    if (e instanceof HubtelOutcomeUnknownError) {
      await quiet(deps.markOrder(order.id, { status: "processing", notes: `Hubtel: outcome unknown [hcsRef:${e.clientReference}]. Do not resend.` }, ["pending"]), "markOrder")
      await quiet(deps.alert(`Airtime ${tag}: Hubtel POST may have been sent (ref ${e.clientReference}) - check the Hubtel review queue, do not resend`, "review"), "alert")
      return true
    }
    // Every other error is raised before the POST (disabled, paused, not configured, validation, insert failure).
    return notSent(e?.message ?? "error")
  }
}
