import type { SupabaseClient } from "@supabase/supabase-js"
import { shopCodeByIdWith } from "../shop/default-deps"
import type { TtbSettings } from "../settings"
import type { CallDeps } from "./decide"

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
    normalizeSender: (raw) => {
      const s = typeof raw === "string" ? raw.trim() : ""
      if (!/^\+?\d+$/.test(s)) return null
      // Same rule as the SMS webhook's customerPhone: 0XXXXXXXXX, 233XXXXXXXXX or +233XXXXXXXXX, a Ghana mobile.
      const d = s.replace(/^\+/, "")
      const sig = d.startsWith("233") ? d.slice(3) : d.startsWith("0") ? d.slice(1) : null
      return sig && /^[2-9]\d{8}$/.test(sig) ? `0${sig}` : null
    },
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
