import type { SupabaseClient } from "@supabase/supabase-js"
import type { BundlesDeps } from "./service"
import type { SpecialChildRow, SpecialDeps, SpecialRpcResult } from "./special-service"

const TABLE = "hubtel_data_orders"

/** The normal dashboard deps plus the 0141 RPC, the group read and `after()`. getBundlesRuntime stays untouched. */
export function buildSpecialDeps(base: BundlesDeps, db: SupabaseClient, schedule: (task: () => Promise<void>) => void): SpecialDeps {
  return {
    ...base,
    async createSpecialOrders(a): Promise<SpecialRpcResult> {
      const { data, error } = await db.rpc("create_special_bundle_orders", {
        p_user: a.userId, p_group_key: a.groupKey, p_n: a.n, p_rows: a.rows, p_total: a.total,
      })
      if (error) {
        const m = String((error as { message?: unknown }).message ?? "")
        if (m === "INSUFFICIENT_FUNDS") return { ok: false, error: "insufficient" }
        if (m === "BAD_INPUT") {
          const detail = (error as { details?: unknown }).details
          return { ok: false, error: "bad_input", ...(typeof detail === "string" ? { detail } : {}) }
        }
        throw new Error(`create_special_bundle_orders failed: ${m || "unknown error"}`) // outcome unknown
      }
      const r = data as { group_id?: unknown; order_ids?: unknown; replay?: unknown } | null
      if (!r || typeof r.group_id !== "string" || !Array.isArray(r.order_ids) || !r.order_ids.every(x => typeof x === "string") || typeof r.replay !== "boolean") {
        throw new Error("create_special_bundle_orders returned an unexpected result")
      }
      return { ok: true, groupId: r.group_id, orderIds: r.order_ids as string[], replay: r.replay }
    },
    async listSpecialGroup(userId, groupId) {
      const { data, error } = await db.from(TABLE).select("*").eq("user_id", userId).eq("special_group_id", groupId)
        .order("special_index", { ascending: true })
      if (error) throw error
      return (data as SpecialChildRow[] | null) ?? []
    },
    schedule,
  }
}
