// lib/ussd-hubtel/flows/airtime.ts
// Buy Airtime on the Hubtel channel. Port of lib/ussd/handlers/airtime.ts minus wallet, Paystack
// and OTP: CONFIRM ends in AddToCart. Fee-inclusive pricing exactly like Uzo: the caller enters
// what they pay; the recipient gets amount - fee (splitInclusive).
import { detectAirtimeNetwork, splitInclusive } from "@/lib/airtime-pricing"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { secureReference } from "@/lib/secure-random"
import { AIRTIME_NETWORKS, airtimeLabel, type AirtimeNetworkKey } from "../menus"
import { toLocalPhone } from "../protocol"
import { backToMain, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { HubtelReply } from "../types"

const RECIPIENT = { label: "Recipient number", fieldType: "phone" as const }
const NETWORK = { label: "Recipient network" }
const AMOUNT = { label: "Airtime amount", fieldType: "decimal" as const }
const CONFIRM = { label: "Confirm airtime" }
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

export function airtimeRecipientPromptText(): string {
  return "Buy Airtime\nEnter recipient number\n(who gets the airtime):\n0. Back"
}

export function airtimeNetworkMenuText(): string {
  return "Select recipient network:\n" + AIRTIME_NETWORKS.map(n => `${n.digit}. ${n.label}`).join("\n") + "\n0. Back"
}

export function airtimeAmountPromptText(label: string, min: number, max: number): string {
  return `${label} Airtime\nEnter amount to pay\n(GHS ${min} - ${max}):\n0. Back`
}

export function airtimeConfirmText(label: string, recipient: string, pay: number, get: number, payerLocal: string): string {
  return (
    `Confirm Airtime\n${label} to ${recipient}\nYou pay GHS ${pay.toFixed(2)}\n` +
    `They get GHS ${get.toFixed(2)}\nfrom ${payerLocal}\n1. Pay now\n2. Cancel`
  )
}

const isDealerRole = (role?: string) => role === "dealer" || role === "sub_agent"

export async function startAirtime(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "AIRTIME_ENTER_RECIPIENT" }, airtimeRecipientPromptText(), RECIPIENT)
}

const toRecipient = (ctx: FlowCtx, msg = "") =>
  goto(ctx, { step: "AIRTIME_ENTER_RECIPIENT", airtimeRecipient: undefined, airtimeNetwork: undefined },
    (msg ? `${msg}\n` : "") + airtimeRecipientPromptText(), RECIPIENT)

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return backToMain(ctx)
  const local = toLocalPhone(ctx.input.replace(/\s+/g, ""))
  if (!/^0[0-9]{9}$/.test(local)) return say(ctx, "Invalid number.\n" + airtimeRecipientPromptText(), "AIRTIME_ENTER_RECIPIENT", RECIPIENT)
  const network = detectAirtimeNetwork(local)
  if (!network) {
    // Unknown prefix: let the caller say which network the recipient is on.
    return goto(ctx, { step: "AIRTIME_SELECT_NETWORK", airtimeRecipient: local }, airtimeNetworkMenuText(), NETWORK)
  }
  return applyNetwork(ctx, local, network)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return toRecipient(ctx)
  const picked = AIRTIME_NETWORKS.find(n => n.digit === ctx.input)
  if (!picked) return say(ctx, airtimeNetworkMenuText(), "AIRTIME_SELECT_NETWORK", NETWORK)
  return applyNetwork(ctx, ctx.session.airtimeRecipient!, picked.key)
}

/** Shared tail of recipient entry and network pick: availability + prefix gate, then ask the amount. */
async function applyNetwork(ctx: FlowCtx, local: string, network: AirtimeNetworkKey): Promise<HubtelReply> {
  const { deps } = ctx
  const label = airtimeLabel(network)
  if (!(await deps.airtime.isEnabled(network))) return toRecipient(ctx, `${label} airtime is unavailable.`)
  // Same hard block the web purchase path applies (purchaseAirtime): never top up a number that
  // the admin prefix map says is on another network.
  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled) {
    const check = validateNetworkPrefix(network, local, prefix.map)
    if (!check.ok) return toRecipient(ctx, check.message ?? "Number does not match the network.")
  }
  const { min, max } = await deps.airtime.getLimits()
  return goto(ctx, { step: "AIRTIME_ENTER_AMOUNT", airtimeRecipient: local, airtimeNetwork: network },
    airtimeAmountPromptText(label, min, max), AMOUNT)
}

async function enterAmount(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, session } = ctx
  if (ctx.input === "0") return toRecipient(ctx)
  const network = session.airtimeNetwork!
  const label = airtimeLabel(network)
  const { min, max } = await deps.airtime.getLimits()
  const invalid = () => say(ctx, "Enter a valid amount.\n" + airtimeAmountPromptText(label, min, max), "AIRTIME_ENTER_AMOUNT", AMOUNT)

  const amount = AMOUNT_RE.test(ctx.input) ? Number(ctx.input) : NaN
  if (!(amount > 0) || amount < min || amount > max) return invalid()

  const dialer = await deps.resolveDialer(session.dialingPhone)
  const rate = await deps.airtime.feeRate(network, isDealerRole(dialer.role))
  const { fee, toDeliver } = splitInclusive(amount, rate)
  if (!(toDeliver > 0)) return invalid()

  return goto(ctx, {
    step: "AIRTIME_CONFIRM", airtimeAmount: amount, airtimeFee: fee, airtimeToDeliver: toDeliver, userId: dialer.userId,
  }, airtimeConfirmText(label, session.airtimeRecipient!, amount, toDeliver, toLocalPhone(session.dialingPhone)), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const network = session.airtimeNetwork!
  const label = airtimeLabel(network)
  const amount = session.airtimeAmount!
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  if (ctx.input !== "1") {
    return say(ctx, airtimeConfirmText(label, session.airtimeRecipient!, amount, session.airtimeToDeliver!, toLocalPhone(session.dialingPhone)), "AIRTIME_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Stale-session guard: settings may have changed since the confirm screen was shown.
  if (!(await deps.airtime.isEnabled(network))) return finish(ctx, `${label} airtime is no longer available.`)
  const { min, max } = await deps.airtime.getLimits()
  if (amount < min || amount > max) return finish(ctx, `Amount must be GHS ${min}-${max}. Please restart.`)
  const dialer = await deps.resolveDialer(session.dialingPhone)
  const rate = await deps.airtime.feeRate(network, isDealerRole(dialer.role))
  const { fee, toDeliver } = splitInclusive(amount, rate)
  if (Math.abs(toDeliver - session.airtimeToDeliver!) > 0.001) {
    return finish(ctx, "Airtime rates changed. Please restart your order.")
  }

  return submitOrder(ctx, {
    table: "airtime_orders",
    price: amount,
    logTag: "HUBTEL-AIRTIME",
    row: {
      reference_code: secureReference("AT", 2, 3),
      network,
      beneficiary_phone: session.airtimeRecipient,
      airtime_amount: toDeliver,
      fee_amount: fee,
      total_paid: amount, // our price; Hubtel adds its own charge on top, at Hubtel
      pay_separately: false,
      status: "pending_payment",
      payment_status: "pending_payment",
      user_id: dialer.userId ?? null,
      shop_id: null,
      merchant_commission: 0,
      customer_name: "USSD Customer",
      customer_email: dialer.email ?? null,
      dialing_phone: session.dialingPhone,
      channel: "ussd",
    },
  })
}

export const AIRTIME_STEPS: StepTable = {
  AIRTIME_ENTER_RECIPIENT: enterRecipient,
  AIRTIME_SELECT_NETWORK: selectNetwork,
  AIRTIME_ENTER_AMOUNT: enterAmount,
  AIRTIME_CONFIRM: confirm,
}
