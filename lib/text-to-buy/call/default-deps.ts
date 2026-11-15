import type { SupabaseClient } from "@supabase/supabase-js"
import { shopCodeByIdWith } from "../shop/default-deps"
import type { TtbSettings } from "../settings"
import type { CallDeps } from "./decide"
import { normalizeCaller } from "./normalize"

/**
 * Production wiring for handleMissedCall. Nothing here builds a client at import time: every module that does is imported
 * lazily and handed the caller's own client (the same pattern as shop/default-deps.ts).
 */
export function defaultCallDeps(db: SupabaseClient, settings: TtbSettings): CallDeps {
  const lookup = async (code: string) => {
    const { resolveShopCode } = await import("../../shop-commerce/shop-code")
    return resolveShopCode(code, db as unknown as Parameters<typeof resolveShopCode>[1])
  }
  return {
    settings,
    normalizeSender: normalizeCaller,
    isBlocked: async (sender) => (await import("../store")).isBlocked(db, sender),
    noticeOnce: async (kind, sender, shopId, day) => (await import("../store")).noticeOnce(db, kind, sender, shopId, day),
    repliedCallsLastHour: async (line) => (await import("../store")).repliedCallsLastHour(db, line),
    getShopPref: async (sender) => (await import("../store")).getShopPref(db, sender),
    lastBoughtShopCodeId: async (senderLocal) => (await import("../store")).lastBoughtShopCodeId(db, senderLocal),
    shopCodeById: (shopCodeId) => shopCodeByIdWith(db, lookup, shopCodeId),
    shopAccountFor: async (shopId) => (await import("../shop/credits")).shopAccountFor(db, shopId),
    shopReplyCapReached: async (shopId) => (await import("../shop/credits")).shopReplyCapReached(db, shopId, settings),
    sendReply: async (r) => (await import("../send-reply")).sendReply(db, r),
    readSupportWhatsapp: async () => (await import("./support")).readSupportWhatsapp(db),
    logCall: async (c) => (await import("../store")).logCall(db, c),
    alertAdmin: async (message) => {
      const { notifyAdmins } = await import("@/lib/sms-service")
      await notifyAdmins(message, "text_to_buy")
    },
  }
}
