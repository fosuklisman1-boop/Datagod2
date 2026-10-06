// lib/ussd-hubtel/flows/afa.ts
// AFA Registration on the Hubtel channel. Port of lib/ussd/handlers/afa.ts minus Paystack:
// CONFIRM ends in AddToCart at the AFA price (no Paystack fee). AFA is an MTN registration whose
// contact number is the dialer, so only MTN callers may start it.
import { parseGhanaCardNumber } from "@/lib/ghana-card"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { toLocalPhone } from "../protocol"
import { backToMain, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { HubtelReply } from "../types"

const NAME = { label: "Full name", fieldType: "text" as const }
const CARD = { label: "Ghana Card number", fieldType: "text" as const }
const LOCATION = { label: "City or town", fieldType: "text" as const }
const REGION = { label: "Region", fieldType: "text" as const }
const CONFIRM = { label: "Confirm AFA registration" }

const NAME_RE = /^[A-Za-z][A-Za-z .'-]{2,99}$/
const isPlace = (s: string) => s.length >= 2 && s.length <= 100
const UNAVAILABLE = "AFA registration is unavailable right now. Please try again later."

export function afaNamePromptText(): string {
  return "AFA Registration\nEnter your full name:\n0. Back"
}
export function afaCardPromptText(): string {
  return "Enter your Ghana Card\nnumber:\n(e.g. GHA-123456789-0)\n0. Back"
}
export function afaLocationPromptText(): string {
  return "Enter your city or town:\n(e.g. Accra)\n0. Back"
}
export function afaRegionPromptText(): string {
  return "Enter your region:\n(e.g. Ashanti,\nGreater Accra)\n0. Back"
}
export function afaConfirmText(name: string, card: string, price: number, payerLocal: string): string {
  // Display only: a long name must never push "1. Pay now / 2. Cancel" past the 182-char limit.
  const shown = name.length > 40 ? name.slice(0, 40) + "..." : name
  return (
    `AFA Registration\n${shown}\nCard: ${card}\nGHS ${price.toFixed(2)} from ${payerLocal}\n` +
    `Takes 12-24hrs to reflect\n1. Pay now\n2. Cancel`
  )
}

export async function startAfa(ctx: FlowCtx): Promise<HubtelReply> {
  // Applied regardless of the prefix-validation toggle: Uzo charged AFA as MTN MoMo, so non-MTN
  // callers could never complete it, and the registered contact is this number.
  const prefix = await ctx.deps.getPrefixConfig()
  const check = validateNetworkPrefix("MTN", toLocalPhone(ctx.session.dialingPhone), prefix.map)
  if (!check.ok) return finish(ctx, "AFA registration needs an MTN number.\nPlease dial from your MTN line.")
  return goto(ctx, { step: "AFA_ENTER_NAME" }, afaNamePromptText(), NAME)
}

async function enterName(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return backToMain(ctx)
  const name = ctx.input.replace(/\s+/g, " ")
  if (!NAME_RE.test(name)) return say(ctx, "Use letters only\n(3-100 characters).\n" + afaNamePromptText(), "AFA_ENTER_NAME", NAME)
  return goto(ctx, { step: "AFA_ENTER_CARD", afaFullName: name }, afaCardPromptText(), CARD)
}

async function enterCard(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "AFA_ENTER_NAME" }, afaNamePromptText(), NAME)
  // Reject here, before payment: a malformed number used to surface only as a failed order after paying.
  const card = parseGhanaCardNumber(ctx.input)
  if (!card) return say(ctx, "Invalid Ghana Card number.\nUse the format:\nGHA-123456789-0\n0. Back", "AFA_ENTER_CARD", CARD)
  return goto(ctx, { step: "AFA_ENTER_LOCATION", afaGhCard: card }, afaLocationPromptText(), LOCATION)
}

async function enterLocation(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "AFA_ENTER_CARD" }, afaCardPromptText(), CARD)
  if (!isPlace(ctx.input)) return say(ctx, afaLocationPromptText(), "AFA_ENTER_LOCATION", LOCATION)
  return goto(ctx, { step: "AFA_ENTER_REGION", afaLocation: ctx.input }, afaRegionPromptText(), REGION)
}

async function enterRegion(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return goto(ctx, { step: "AFA_ENTER_LOCATION" }, afaLocationPromptText(), LOCATION)
  if (!isPlace(ctx.input)) return say(ctx, afaRegionPromptText(), "AFA_ENTER_REGION", REGION)
  if (!s.afaFullName || !s.afaGhCard) return finish(ctx, UNAVAILABLE)
  const price = await ctx.deps.afa.getPrice()
  if (price === null) return finish(ctx, UNAVAILABLE)
  return goto(ctx, { step: "AFA_CONFIRM", afaRegion: ctx.input, afaPrice: price },
    afaConfirmText(s.afaFullName, s.afaGhCard, price, toLocalPhone(s.dialingPhone)), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session: s } = ctx
  if (ctx.input === "2") return finish(ctx, "Registration cancelled.")
  // A session missing any collected field cannot be confirmed (fail closed, never submit partial data).
  if (!s.afaFullName || !s.afaGhCard || !s.afaLocation || !s.afaRegion || s.afaPrice === undefined) {
    return finish(ctx, UNAVAILABLE)
  }
  if (ctx.input !== "1") {
    return say(ctx, afaConfirmText(s.afaFullName, s.afaGhCard, s.afaPrice, toLocalPhone(s.dialingPhone)), "AFA_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  const price = await deps.afa.getPrice()
  if (price === null) return finish(ctx, UNAVAILABLE)
  // Fail closed: a NaN price must not slip past the drift check.
  if (!(Math.abs(price - s.afaPrice) <= 0.001)) return finish(ctx, `Price changed to GHS ${price.toFixed(2)}. Please restart your order.`)

  return submitOrder(ctx, {
    table: "ussd_afa_orders",
    price,
    logTag: "HUBTEL-AFA",
    row: {
      dialing_phone: s.dialingPhone, // the registered contact (same E.164 form Uzo stored)
      full_name: s.afaFullName,
      gh_card_number: s.afaGhCard,
      location: s.afaLocation,
      region: s.afaRegion,
      occupation: "Farmer",
      amount: price, // our price only: Uzo added a Paystack fee here; Hubtel adds its own charge at Hubtel
      payment_status: "pending",
      order_status: "pending",
    },
  })
}

export const AFA_STEPS: StepTable = {
  AFA_ENTER_NAME: enterName,
  AFA_ENTER_CARD: enterCard,
  AFA_ENTER_LOCATION: enterLocation,
  AFA_ENTER_REGION: enterRegion,
  AFA_CONFIRM: confirm,
}
