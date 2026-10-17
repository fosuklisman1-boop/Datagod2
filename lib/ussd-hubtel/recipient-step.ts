// lib/ussd-hubtel/recipient-step.ts
// Data bundle recipient step (main and shop data): "Who is this for?" -> 1. My Self (caller's number) /
// 2. Someone Else (type a number) / 0. Back. Either way the number is checked the same way (format, then the
// admin-toggleable network prefix map) before the confirm screen.
import { validateNetworkPrefix } from "@/lib/phone-format"
import { recipientPromptText, whoForText } from "./menus"
import { toLocalPhone } from "./protocol"
import { goto, say, type FlowCtx } from "./flow-kit"
import type { HubtelReply, HubtelStep } from "./types"

const WHO_FOR = { label: "Who is this for" }
const TYPE_NUMBER = { label: "Recipient number", fieldType: "phone" as const }

/** First screen of the step (after a package is chosen). */
export const whoForScreen = (ctx: FlowCtx, prefix = "") => `${prefix}${whoForText(toLocalPhone(ctx.session.dialingPhone))}`

async function problemWith(ctx: FlowCtx, local: string): Promise<string | null> {
  if (!/^0[0-9]{9}$/.test(local)) return "Invalid number. Enter a valid Ghana phone number."
  const prefix = await ctx.deps.getPrefixConfig()
  if (prefix.enabled && ctx.session.network) {
    const check = validateNetworkPrefix(ctx.session.network, local, prefix.map)
    if (!check.ok) return check.message ?? "Number does not match the selected network."
  }
  return null
}

export async function recipientStep(ctx: FlowCtx, o: {
  step: HubtelStep
  back: () => Promise<HubtelReply>
  confirm: (local: string) => Promise<HubtelReply>
}): Promise<HubtelReply> {
  const { input, session } = ctx
  if (session.otherRecipient) {
    if (input === "0") return goto(ctx, { step: o.step, otherRecipient: false }, whoForScreen(ctx), WHO_FOR)
    const local = toLocalPhone(input.replace(/\s+/g, ""))
    const problem = await problemWith(ctx, local)
    if (problem) return say(ctx, `${problem}\n${recipientPromptText()}`, o.step, TYPE_NUMBER)
    return o.confirm(local)
  }
  if (input === "0") return o.back()
  if (input === "2") return goto(ctx, { step: o.step, otherRecipient: true }, recipientPromptText(), TYPE_NUMBER)
  if (input !== "1") return say(ctx, whoForScreen(ctx), o.step, WHO_FOR)
  const own = toLocalPhone(session.dialingPhone)
  const problem = await problemWith(ctx, own)
  if (problem) return say(ctx, whoForScreen(ctx, `${problem}\n`), o.step, WHO_FOR)
  return o.confirm(own)
}

/** What goes with goto() when entering the step. */
export const enterRecipientStep = { patch: { otherRecipient: false }, field: WHO_FOR }
