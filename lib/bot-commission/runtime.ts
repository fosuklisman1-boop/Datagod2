import type { SupabaseClient } from "@supabase/supabase-js"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import type { BotBillsDeps, BotBundlesDeps, BotOrderRow } from "./orders"

/** Columns a bot order result is built from (BotOrderRow). */
const ORDER_ROW = "id, reference_code, amount, paid_amount, payment_fee_amount, cashback_amount"

/** Service-role deps for bot bill orders (in-process; the bots run their own session controls). */
export function getBotBillsRuntime(): { deps: BotBillsDeps; db: SupabaseClient } {
  const { deps, db } = getBillsRuntime()
  return {
    db,
    deps: {
      ...deps,
      async insertBotBillOrder(row) {
        const { data, error } = await db.from("hubtel_bill_orders").insert(row).select(ORDER_ROW).single()
        if (error) throw error // 23505 => the service returns the token's existing order or retries the reference
        return data as BotOrderRow
      },
      async findBotBillOrderByHash(botSurface, buyerPhone, verifyTokenHash) {
        const { data, error } = await db
          .from("hubtel_bill_orders")
          .select(ORDER_ROW)
          .eq("channel", "bots")
          .eq("bot_surface", botSurface)
          .eq("buyer_phone", buyerPhone)
          .eq("verify_token_hash", verifyTokenHash)
          .maybeSingle()
        if (error) throw error
        return (data as BotOrderRow | null) ?? null
      },
    },
  }
}

/** Service-role deps for bot bundle orders (in-process). */
export function getBotBundlesRuntime(): { deps: BotBundlesDeps; db: SupabaseClient } {
  const { deps, db } = getBundlesRuntime()
  return {
    db,
    deps: {
      ...deps,
      async findBotBundleOrder(botSurface, buyerPhone, idempotencyKey) {
        const { data, error } = await db
          .from("hubtel_data_orders")
          .select(ORDER_ROW)
          .eq("channel", "bots")
          .eq("bot_surface", botSurface)
          .eq("buyer_phone", buyerPhone)
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle()
        if (error) throw error
        return (data as BotOrderRow | null) ?? null
      },
      async insertBotBundleOrder(row) {
        const { data, error } = await db.from("hubtel_data_orders").insert(row).select(ORDER_ROW).single()
        if (error) throw error // 23505 => the service looks the winner up by (surface, buyer, key)
        return data as BotOrderRow
      },
    },
  }
}
