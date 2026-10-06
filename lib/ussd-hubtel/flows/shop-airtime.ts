// lib/ussd-hubtel/flows/shop-airtime.ts
// Shop-mode Buy Airtime. Port of lib/ussd-shop/handlers/airtime.ts minus Paystack and OTP: CONFIRM
// ends in AddToCart at what the caller typed (no fee added). The SHOP's fee: platform base rate for
// the shop OWNER's tier + the shop's airtime markup (total capped at 10%), via deps.shop.airtimeFeeRate;
// the markup share of what is delivered is the shop's merchant_commission, credited to shop_id after
// payment by markAirtimeOrderPaid (Plan 2's airtime_orders handler, unchanged). The shop token was
// already billed at the code step: nothing is billed here.
import { detectAirtimeNetwork } from "@/lib/airtime-pricing"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { secureReference } from "@/lib/secure-random"
import { AIRTIME_NETWORKS, airtimeLabel, shopHeader, type AirtimeNetworkKey } from "../menus"
import { toLocalPhone } from "../protocol"
import { shopAirtimeQuote } from "../shop-services"
import { finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import { backToProduct } from "./shop"
import type { HubtelReply } from "../types"

const RECIPIENT = { label: "Recipient number", fieldType: "phone" as const }
const NETWORK = { label: "Recipient network" }
const AMOUNT = { label: "Airtime amount", fieldType: "decimal" as const }
const CONFIRM = { label: "Confirm airtime" }
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

export function shopAirtimeRecipientText(shopName: string): string {
  return `${shopHeader(shopName)}\nBuy Airtime\nEnter recipient number:\n0. Back`
}

export function shopAirtimeNetworkText(): string {
  return "Select recipient network:\n" + AIRTIME_NETWORKS.map(n => `${n.digit}. ${n.label}`).join("\n") + "\n0. Back"
}

export function shopAirtimeAmountText(label: string, min: number, max: number): string {
  return `${label} Airtime\nEnter amount to pay\n(GHS ${min} - ${max}):\n0. Back`
}

export function shopAirtimeConfirmText(shopName: string, label: string, recipient: string, pay: number, get: number, payerLocal: string): string {
  return (
    `${shopHeader(shopName)}\n${label} to ${recipient}\nYou pay GHS ${pay.toFixed(2)}\n` +
    `They get GHS ${get.toFixed(2)}\nfrom ${payerLocal}\n1. Pay now\n2. Cancel`
  )
}

const nameOf = (ctx: FlowCtx) => ctx.session.shopName ?? "Shop"

/** A quote is usable only when every part is a finite number and something is delivered (fail closed). */
function usableQuote(q: { fee: number; toDeliver: number; commission: number }): boolean {
  return Number.isFinite(q.fee) && q.fee >= 0
    && Number.isFinite(q.toDeliver) && q.toDeliver > 0
    && Number.isFinite(q.commission) && q.commission >= 0
}

export async function startShopAirtime(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "SHOP_AIRTIME_ENTER_RECIPIENT" }, shopAirtimeRecipientText(nameOf(ctx)), RECIPIENT)
}

const toRecipient = (ctx: FlowCtx, msg = "") =>
  goto(ctx, { step: "SHOP_AIRTIME_ENTER_RECIPIENT", airtimeRecipient: undefined, airtimeNetwork: undefined },
    (msg ? `${msg}\n` : "") + shopAirtimeRecipientText(nameOf(ctx)), RECIPIENT)

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return backToProduct(ctx) // D5: never back to code entry
  const local = toLocalPhone(ctx.input.replace(/\s+/g, ""))
  if (!/^0[0-9]{9}$/.test(local)) {
    return say(ctx, "Invalid number.\n" + shopAirtimeRecipientText(nameOf(ctx)), "SHOP_AIRTIME_ENTER_RECIPIENT", RECIPIENT)
  }
  const network = detectAirtimeNetwork(local)
  // Unknown prefix: let the caller say which network the recipient is on (Uzo).
  if (!network) return goto(ctx, { step: "SHOP_AIRTIME_SELECT_NETWORK", airtimeRecipient: local }, shopAirtimeNetworkText(), NETWORK)
  return applyNetwork(ctx, local, network)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return toRecipient(ctx)
  const picked = AIRTIME_NETWORKS.find(n => n.digit === ctx.input)
  if (!picked) return say(ctx, shopAirtimeNetworkText(), "SHOP_AIRTIME_SELECT_NETWORK", NETWORK)
  const local = ctx.session.airtimeRecipient
  if (!local) return toRecipient(ctx)
  return applyNetwork(ctx, local, picked.key)
}

/** Shared tail of recipient entry and network pick: availability + prefix gate (Plan 2 D7), then ask the amount. */
async function applyNetwork(ctx: FlowCtx, local: string, network: AirtimeNetworkKey): Promise<HubtelReply> {
  const { deps } = ctx
  const label = airtimeLabel(network)
  if (!(await deps.airtime.isEnabled(network))) return toRecipient(ctx, `${label} airtime is unavailable.`)
  // Same hard block as the web purchase path: never top up a number the admin prefix map puts on another network.
  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled) {
    const check = validateNetworkPrefix(network, local, prefix.map)
    if (!check.ok) return toRecipient(ctx, check.message ?? "Number does not match the network.")
  }
  const { min, max } = await deps.airtime.getLimits()
  return goto(ctx, { step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeRecipient: local, airtimeNetwork: network },
    shopAirtimeAmountText(label, min, max), AMOUNT)
}

async function enterAmount(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, session } = ctx
  if (ctx.input === "0") return toRecipient(ctx)
  const network = session.airtimeNetwork
  if (!network || !session.shopId) return toRecipient(ctx)
  const label = airtimeLabel(network)
  const { min, max } = await deps.airtime.getLimits()
  const invalid = () => say(ctx, "Enter a valid amount.\n" + shopAirtimeAmountText(label, min, max), "SHOP_AIRTIME_ENTER_AMOUNT", AMOUNT)

  const amount = AMOUNT_RE.test(ctx.input) ? Number(ctx.input) : NaN
  if (!(amount > 0 && amount >= min && amount <= max)) return invalid()
  const q = shopAirtimeQuote(amount, await deps.shop.airtimeFeeRate(session.shopId, network))
  if (!usableQuote(q)) return invalid()

  return goto(ctx, { step: "SHOP_AIRTIME_CONFIRM", airtimeAmount: amount, airtimeFee: q.fee, airtimeToDeliver: q.toDeliver },
    shopAirtimeConfirmText(nameOf(ctx), label, session.airtimeRecipient!, amount, q.toDeliver, toLocalPhone(session.dialingPhone)), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  const network = session.airtimeNetwork
  const amount = session.airtimeAmount
  const shown = session.airtimeToDeliver
  if (!network || !session.shopId || !session.airtimeRecipient) return finish(ctx, "Airtime rates changed. Please restart your order.")
  const label = airtimeLabel(network)
  if (ctx.input !== "1") {
    if (!Number.isFinite(amount) || !Number.isFinite(shown)) return finish(ctx, "Airtime rates changed. Please restart your order.")
    return say(ctx, shopAirtimeConfirmText(nameOf(ctx), label, session.airtimeRecipient, amount as number, shown as number, toLocalPhone(session.dialingPhone)), "SHOP_AIRTIME_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Stale-session guard (D11): availability, limits and the shop's markup may have changed.
  if (!(await deps.airtime.isEnabled(network))) return finish(ctx, `${label} airtime is no longer available.`)
  const { min, max } = await deps.airtime.getLimits()
  if (!(typeof amount === "number" && amount > 0 && amount >= min && amount <= max)) {
    return finish(ctx, `Amount must be GHS ${min}-${max}. Please restart.`)
  }
  const q = shopAirtimeQuote(amount, await deps.shop.airtimeFeeRate(session.shopId, network))
  // Fail closed: a NaN/undefined on either side must never pass the drift check.
  if (!usableQuote(q) || !Number.isFinite(shown) || !(Math.abs(q.toDeliver - (shown as number)) <= 0.001)) {
    return finish(ctx, "Airtime rates changed. Please restart your order.")
  }

  return submitOrder(ctx, {
    table: "airtime_orders",
    price: amount,
    logTag: "HUBTEL-SHOP-AIRTIME",
    // Same columns as lib/shop-commerce/orders.ts createShopAirtimeOrder (the Uzo shop insert).
    row: {
      reference_code: secureReference("AT", 2, 3),
      network,
      beneficiary_phone: session.airtimeRecipient,
      airtime_amount: q.toDeliver, // what the beneficiary receives
      fee_amount: q.fee,
      total_paid: amount, // what the caller pays = Hubtel Price; Hubtel adds its own charge on top
      pay_separately: false,
      status: "pending_payment",
      payment_status: "pending_payment",
      user_id: null,
      shop_id: session.shopId,
      merchant_commission: q.commission, // credited to shop_id by markAirtimeOrderPaid after payment
      customer_name: "USSD Customer",
      customer_email: null,
      dialing_phone: session.dialingPhone,
      channel: "ussd_shop",
    },
  })
}

export const SHOP_AIRTIME_STEPS: StepTable = {
  SHOP_AIRTIME_ENTER_RECIPIENT: enterRecipient,
  SHOP_AIRTIME_SELECT_NETWORK: selectNetwork,
  SHOP_AIRTIME_ENTER_AMOUNT: enterAmount,
  SHOP_AIRTIME_CONFIRM: confirm,
}
