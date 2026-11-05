// Gateway choice for the USSD menu charges (Uzo main menu, Uzo shop menu) and the shared handlers the WhatsApp bot
// reuses. Every one of these charges uses the order id as its reference, and a confirm always writes a new order.
//
// The order amount is decided before the row is written: USSD prices carry Paystack's fee (`price + fee`), Hubtel's
// don't (Hubtel adds its own charge). A charge priced for Hubtel that ends up on Paystack moves the order to the
// Paystack price first and charges that, or charges nothing: Paystack is never asked for a fee-less amount where a
// fee applies.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ChargeMobileMoneyParams } from "@/lib/paystack"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import type { SurfaceKey } from "@/lib/payment-gateway/config"
import {
  FallbackRefusedError, resolveSurfaceGateway, startMomoCharge, type StartDeps, type StartMomoResult,
} from "@/lib/payment-gateway/start"
import { paystackProviderFromPhone } from "./paystack-provider"

export type UssdChannel = "ussd" | "whatsapp"

/** The gateway surface of a charge: `whatsapp` when the handler runs for the WhatsApp bot, else `ussd`. */
export const ussdChargeSurface = (channel: UssdChannel | undefined): SurfaceKey => (channel === "whatsapp" ? "whatsapp" : "ussd")

/** The number forms startMomoCharge can send to Hubtel as they are. */
const SENDABLE = /^(\+?233|0)\d{9}$/

/**
 * Can this charge go to Hubtel without an unsolicited prompt? The number charged must be the session owner's own:
 * the dialling number on USSD, the sender on WhatsApp (whose router overwrites session.dialingPhone with the typed
 * MoMo number, so the owner there is the session id). Both are canonicalised once with normalizeGhanaPhone; no
 * canonical form means no. The provider must be the charged number's own network, because it picks Hubtel's channel.
 */
export function isUssdHubtelPayer(o: { chargePhone: string | undefined; ownerPhone: string | undefined; provider: string | undefined }): boolean {
  const charged = normalizeGhanaPhone(o.chargePhone ?? "")
  const owner = normalizeGhanaPhone(o.ownerPhone ?? "")
  if (!charged || charged !== owner || !SENDABLE.test(o.chargePhone ?? "")) return false
  return paystackProviderFromPhone(charged) === o.provider
}

/** An order's MoMo price on each gateway. Equal where the handler adds no Paystack fee. */
export interface UssdPrice {
  hubtel: number
  paystack: number
}

const pesewas = (ghs: number): number => Math.round(ghs * 100)

/** The Hubtel-priced amount a session recorded for this order, if it recorded one for this very order. */
export function pendingOrderAmountFor(
  session: { pendingOrderAmount?: { orderId: string; amount: number } },
  orderId: string,
): number | undefined {
  const p = session.pendingOrderAmount
  return p && p.orderId === orderId && Number.isFinite(p.amount) ? p.amount : undefined
}

/**
 * The MoMo amount to write on a new order: the Hubtel price when this surface would charge it on Hubtel, today's
 * price otherwise. No fee difference means no config read at all.
 */
export async function ussdOrderAmount(
  surface: SurfaceKey,
  verifiedPayer: boolean,
  price: UssdPrice,
  deps?: Partial<Pick<StartDeps, "getConfig" | "isReady">>,
): Promise<number> {
  if (pesewas(price.hubtel) >= pesewas(price.paystack)) return price.paystack
  const { gateway } = await resolveSurfaceGateway(surface, { verifiedPayer, amount: price.hubtel }, deps)
  return gateway === "hubtel" ? price.hubtel : price.paystack
}

export interface UssdChargeInput {
  surface: SurfaceKey
  /** isUssdHubtelPayer for this charge. */
  verifiedPayer: boolean
  price: UssdPrice
  /** The MoMo amount the order row carries now (ussdOrderAmount's answer when it was written). */
  written: number
  /** Today's Paystack params, unchanged. `amount` is set here. */
  params: Omit<ChargeMobileMoneyParams, "amount">
  /**
   * Moves the order from `written` to the Paystack price, guarded on it still being unpaid at `written`. True when
   * exactly that row changed. Must not throw.
   */
  reprice: () => Promise<boolean>
}

/**
 * The charge, on whichever gateway the surface's config picks. An order written at the Paystack price only goes to
 * Hubtel when there is no fee difference, so Hubtel is never asked for a fee it doesn't charge. An order written below
 * the Paystack price carries onFallback: any Paystack path re-prices the row first, and refuses (FallbackRefusedError,
 * nothing charged) if that write fails. `amount` is what the charge asked for.
 */
export async function startUssdCharge(i: UssdChargeInput, deps?: Partial<StartDeps>): Promise<StartMomoResult & { amount: number }> {
  const written = pesewas(i.written)
  const paystack = pesewas(i.price.paystack)
  const feeless = written < paystack
  const hubtel = i.verifiedPayer && (feeless || pesewas(i.price.hubtel) === paystack)
  let amount = i.written
  const onFallback = async (): Promise<{ amount: number }> => {
    if (!(await i.reprice())) throw new FallbackRefusedError()
    amount = i.price.paystack
    return { amount }
  }
  const result = await startMomoCharge(
    i.surface,
    { ...i.params, amount: i.written, verifiedPayer: hubtel, ...(feeless ? { onFallback } : {}) },
    deps,
  )
  return { ...result, amount }
}

/**
 * A guarded price move for startUssdCharge's `reprice`: `set` is written only while the row is still `guards` and
 * still carries `from`. Logs PII-free and never throws.
 */
export function guardedReprice(
  db: SupabaseClient,
  table: string,
  orderId: string,
  o: { from: Record<string, number>; set: Record<string, unknown>; guards: Record<string, string> },
): () => Promise<boolean> {
  return async () => {
    try {
      let q = db.from(table).update({ ...o.set, updated_at: new Date().toISOString() }).eq("id", orderId)
      for (const [column, value] of Object.entries(o.guards)) q = q.eq(column, value)
      for (const [column, value] of Object.entries(o.from)) q = q.eq(column, value)
      const { data, error } = await q.select("id")
      if (error) {
        console.error(`[ussd-gateway] ${table} reprice failed:`, error.code ?? "no code")
        return false
      }
      return (data?.length ?? 0) === 1
    } catch (e) {
      console.error(`[ussd-gateway] ${table} reprice threw:`, e instanceof Error ? e.message : "unknown error")
      return false
    }
  }
}
