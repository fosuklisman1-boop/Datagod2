// Real dependencies for deliverPrize (lib/leaderboard/delivery.ts): the 0137
// RPCs, the wallet credit RPC, and the same order-fulfilment paths regular
// purchases use. Server only.

import type { SupabaseClient } from "@supabase/supabase-js"
import { secureReference } from "../secure-random"
import type { DeliveryDeps, StartedDelivery } from "./delivery"

export function buildDeliveryDeps(db: SupabaseClient, adminId: string): DeliveryDeps {
  return {
    async start(resultId) {
      const { data, error } = await db.rpc("leaderboard_delivery_start", { p_result_id: resultId, p_admin: adminId })
      if (error) throw error
      return data as StartedDelivery
    },

    async finish(deliveryId, status, input = {}) {
      const { error } = await db.rpc("leaderboard_delivery_finish", {
        p_delivery_id: deliveryId, p_status: status, p_admin: adminId,
        p_error: input.error ?? null, p_order_table: input.orderTable ?? null, p_order_id: input.orderId ?? null,
        p_phone: input.phone ?? null, p_note: input.note ?? null,
      })
      if (error) throw error
    },

    async creditWallet(userId, amount, reference, description) {
      const { error } = await db.rpc("credit_wallet_safely", {
        p_user_id: userId, p_amount: amount, p_reference_id: reference, p_description: description, p_source: "leaderboard_prize",
      })
      // A unique violation means this reference was already credited: idempotent success.
      if (error && (error as { code?: string }).code !== "23505") throw error
    },

    async grantDealerDays(userId, days, reference) {
      const { data, error } = await db.rpc("leaderboard_grant_dealer_days", { p_user_id: userId, p_days: days, p_reference: reference })
      if (error) throw error
      // Keep the auth metadata in step, as the paid dealer upgrade does.
      await db.auth.admin.updateUserById(userId, { user_metadata: { role: "dealer" } }).catch(() => {})
      return data as { action: string; end_date: string }
    },

    async getPackage(id) {
      const { data, error } = await db.from("packages").select("id, network, size, name").eq("id", id).maybeSingle()
      if (error) throw error
      return (data as { id: string; network: string; size: string; name: string | null } | null) ?? null
    },

    async createDataOrder({ userId, packageId, network, size, phone, reference }) {
      const { data, error } = await db.from("orders").insert([{
        user_id: userId,
        package_id: packageId,
        network,
        size,
        price: 0,
        phone_number: phone,
        status: "pending",
        queue: "default",
        order_code: `ORD-${reference.slice(0, 11)}-${Date.now()}`,
        created_at: new Date().toISOString(),
      }]).select("id").single()
      if (error) throw error
      return String((data as { id: string }).id)
    },

    async fulfilDataOrder(orderId) {
      const { processManualFulfillment } = await import("../fulfillment-service")
      const result = await processManualFulfillment(orderId, "bulk")
      return { success: result.success, message: result.message }
    },

    async createAirtimeOrder({ userId, network, amount, phone, reference }) {
      const { data, error } = await db.from("airtime_orders").insert([{
        user_id: userId,
        reference_code: secureReference("AT", 2, 3),
        network,
        beneficiary_phone: phone,
        airtime_amount: amount,
        fee_amount: 0,
        total_paid: 0,
        pay_separately: false,
        status: "pending",
        payment_status: "completed",
        notes: `Top Performers prize (${reference})`,
      }]).select("id, reference_code, network, beneficiary_phone, airtime_amount").single()
      if (error) throw error
      return data as { id: string; reference_code: string; network: string; beneficiary_phone: string; airtime_amount: number }
    },

    async fulfilAirtimeOrder(order) {
      const { triggerAirtimeFulfillment } = await import("../airtime-service")
      return triggerAirtimeFulfillment(order)
    },

    async notifyWinner(userId, title, message) {
      const { error } = await db.from("notifications").insert([{
        user_id: userId, title, message, type: "leaderboard_prize", read: false, action_url: "/dashboard/top-performers",
      }])
      if (error) throw error
    },
  }
}
