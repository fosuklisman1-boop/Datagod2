import { sendWhatsAppText } from "./send"

// Handles inbound messages that arrived on the dedicated shop WhatsApp number
// (identified by phone_number_id in the webhook payload, wired in
// app/api/whatsapp/webhook/route.ts). Phase 1: acknowledge only. A later phase
// fills in the full shop-code -> product menu state machine.
export async function shopWaRouter(from: string, _text: string, _inboundMsgId: string | null): Promise<void> {
  await sendWhatsAppText(
    from,
    "🛍️ Shop bot coming soon. Send your shop code to begin.",
    process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID
  )
}

// Pure predicate for the webhook route's phone_number_id branch, pulled out
// so it's unit-testable without mocking the rest of processInbound (which
// touches Supabase, session state, the AI loop, etc.). Mirrors exactly what
// the route checks: shop routing only fires when the env var is configured
// AND matches the phone_number_id Meta sent for this webhook. Unset/mismatch
// -> false, so the caller falls through to the existing main bot/AI flow.
export function isShopWhatsAppNumber(
  receivingPhoneNumberId: string | undefined,
  shopPhoneNumberId: string | undefined = process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID
): boolean {
  return !!shopPhoneNumberId && receivingPhoneNumberId === shopPhoneNumberId
}
