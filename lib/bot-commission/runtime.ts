import type { SupabaseClient } from "@supabase/supabase-js"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import type { NextRequest } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import type { BotCapDeps } from "./caps"
import type { BotBillsDeps, BotBundlesDeps, BotOrderRow } from "./orders"
import { mapBotSpecialRpc, type BotSpecialChild, type BotSpecialDeps } from "./special-orders"

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
        let q = db
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("channel", "bots")
          .eq(column, value)
          .eq("status", "pending")
          .eq("payment_status", "unpaid")
          .gte("created_at", sinceIso)
        // A Special group is one purchase: count only child 1 (single orders have a NULL index). Bills have no such column.
        if (table === "hubtel_data_orders") q = q.or("special_index.is.null,special_index.lte.1")
        const { count, error } = await q
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

/**
 * Service-role deps for bot Special groups (in-process): the bundle deps plus the 0158 RPC and the group read.
 * RPC errors are mapped by mapBotSpecialRpc (documented outcomes only; anything else throws without database text).
 */
export function getBotSpecialRuntime(): { deps: BotSpecialDeps; db: SupabaseClient } {
  const { deps, db } = getBotBundlesRuntime()
  return {
    db,
    deps: {
      ...deps,
      async createBotSpecialOrders(a) {
        const { data, error } = await db.rpc("create_bot_special_bundle_orders", {
          p_surface: a.surface, p_buyer: a.buyer, p_shop: a.shop, p_group_key: a.groupKey, p_n: a.n, p_rows: a.rows, p_total: a.total,
        })
        return mapBotSpecialRpc(data, error)
      },
      async listBotSpecialGroup(botSurface, buyerPhone, key) {
        const first = await db
          .from("hubtel_data_orders")
          .select("special_group_id")
          .eq("channel", "bots")
          .eq("bot_surface", botSurface)
          .eq("buyer_phone", buyerPhone)
          .eq("idempotency_key", `${key}:1`)
          .maybeSingle()
        if (first.error) throw first.error
        const groupId = (first.data as { special_group_id: string | null } | null)?.special_group_id
        if (!groupId) return []
        const { data, error } = await db
          .from("hubtel_data_orders")
          .select("id, special_group_id, special_index, paid_amount")
          .eq("special_group_id", groupId)
          .eq("channel", "bots")
          .eq("bot_surface", botSurface)
          .eq("buyer_phone", buyerPhone)
          .order("special_index", { ascending: true })
        if (error) throw error
        return (data ?? []) as BotSpecialChild[]
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
      caps: botCapDeps(db),
    },
  }
}
