import type { SupabaseClient } from "@supabase/supabase-js"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import type { NextRequest } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import type { BotCapDeps } from "./caps"
import type { BotBillsDeps, BotBundlesDeps, BotOrderRow } from "./orders"

/** Columns a bot order result is built from (BotOrderRow). */
const ORDER_ROW = "id, reference_code, amount, paid_amount, payment_fee_amount, cashback_amount"

/**
 * applyRateLimit takes a request only to derive the identifier when no id is given and for its block log; bots run
 * in-process and always pass an explicit id, so a header-less stand-in is enough.
 */
const NO_REQUEST = { headers: new Headers() } as unknown as NextRequest

/** Atomic limiter + DB backup counts for the bot caps. Limiter fails open; DB errors count as 0 (like storefront). */
export function botCapDeps(db: SupabaseClient): BotCapDeps {
  return {
    limit: async (name, max, windowMs, id) => (await applyRateLimit(NO_REQUEST, name, max, windowMs, id)).allowed,
    async countPending(table, column, value, sinceIso) {
      try {
        const { count, error } = await db
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("channel", "bots")
          .eq(column, value)
          .eq("status", "pending")
          .eq("payment_status", "unpaid")
          .gte("created_at", sinceIso)
        return error ? 0 : count ?? 0
      } catch {
        return 0
      }
    },
    now: Date.now,
  }
}

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
      caps: botCapDeps(db),
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
      caps: botCapDeps(db),
    },
  }
}
