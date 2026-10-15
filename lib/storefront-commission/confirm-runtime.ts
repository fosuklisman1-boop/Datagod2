import type { SupabaseClient } from "@supabase/supabase-js"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { getBillsConfig } from "@/lib/bills/config"
import { dispatchBillOrder, type BillsDeps } from "@/lib/bills/service"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { dispatchBundleOrder, type BundlesDeps } from "@/lib/standard-bundles/service"
import { verifyPayment } from "@/lib/paystack"
import {
  COMMISSION_CHANNELS, confirmBotOrder, settleStorefrontPayment, verifyStorefrontPayment,
  type ConfirmPayment, type ConfirmResult, type SettleDeps, type SettleInput, type StorefrontPaidOrder, type StorefrontPaymentRow, type VerifyDeps,
} from "./confirm"
import { markCommissionOrderPaid } from "./mark-paid"
import { STOREFRONT_ORDER_TABLE, type StorefrontOrderTable, type StorefrontOrderType } from "./payment"

const COLUMNS =
  "id, reference_code, channel, shop_id, status, payment_status, paid_amount, shop_share_amount, payment_reference, hubtel_client_reference, notes, created_at"

/** Wiring of SettleDeps onto the service-role client and the two Hubtel engines (separate so tests can pass fakes). */
export function buildSettleDeps(db: SupabaseClient, bills: BillsDeps, bundles: BundlesDeps): SettleDeps {
  return {
    async getOrder(table, id) {
      const cols = table === "hubtel_bill_orders" ? `${COLUMNS}, biller, verified_at` : COLUMNS
      const { data, error } = await db.from(table).select(cols).eq("id", id).maybeSingle()
      if (error) throw error
      return (data as unknown as StorefrontPaidOrder | null) ?? null
    },
    markPaid: (table, id, patch) => markCommissionOrderPaid(db, table, id, patch, { channels: COMMISSION_CHANNELS }),
    async insertShopProfit(row) {
      const { error } = await db.from("shop_profits").insert([row])
      if (error) throw error
    },
    billsAutoFulfil: async () => (await getBillsConfig(db)).autoFulfil,
    async dispatch(table, id) {
      if (table === "hubtel_bill_orders") {
        const fresh = await bills.getOrder(id)
        return fresh ? dispatchBillOrder(bills, fresh) : "missing"
      }
      const fresh = await bundles.getOrder(id)
      return fresh ? dispatchBundleOrder(bundles, fresh) : "missing"
    },
    async setPendingNote(table, id, notes) {
      const { data, error } = await db
        .from(table)
        .update({ notes, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pending")
        .is("notes", null)
        .select("id")
      if (error) throw error
      return data?.length ?? 0
    },
    async hasLedgerRow(table, id) {
      const { count, error } = await db
        .from("hubtel_cs_transactions")
        .select("id", { count: "exact", head: true })
        .eq("order_table", table)
        .eq("order_id", id)
      if (error) throw error
      return (count ?? 0) > 0
    },
    alert: bills.alert,
    now: Date.now,
    async completePaymentRecords(p) {
      const now = new Date().toISOString()
      const { error } = await db
        .from("wallet_payments")
        .update({ status: "completed", amount_received: p.paidAmount, paystack_transaction_id: p.transactionId, updated_at: now })
        .eq("id", p.walletPaymentId)
      if (error) console.warn("[storefront-confirm] wallet_payments update failed:", error.message)
      const { error: aErr } = await db
        .from("payment_attempts")
        .update({ status: "completed", paystack_transaction_id: p.transactionId, gateway_response: p.gatewayResponse || "success", completed_at: now, updated_at: now })
        .eq("reference", p.reference)
      if (aErr) console.warn("[storefront-confirm] payment_attempts update failed:", aErr.message)
    },
  }
}

function runtimeDeps(): SettleDeps {
  const { deps: bills, db } = getBillsRuntime()
  const { deps: bundles } = getBundlesRuntime()
  return buildSettleDeps(db, bills, bundles)
}

/**
 * Bot order payment confirmed by any rail (Hubtel USSD checkout callback, bot Paystack flows): the same guarded,
 * idempotent confirmation as storefront orders (pesewa-exact amount, unpaid -> paid once, shop share once, one Hubtel
 * POST, resumable). Refuses anything but a channel 'bots' row. `paidAmount` in GHS. Payment-record bookkeeping
 * (wallet_payments etc.) stays with the caller.
 */
export async function confirmBotPayment(
  table: StorefrontOrderTable,
  orderId: string,
  p: ConfirmPayment,
): Promise<ConfirmResult> {
  return confirmBotOrder(runtimeDeps(), table, orderId, p)
}

/** Paystack webhook (charge.success) for a cs_bill / cs_bundle payment. `paidAmount` in GHS. */
export async function settleStorefrontWebhook(
  orderType: StorefrontOrderType,
  s: Omit<SettleInput, "table">,
): Promise<ConfirmResult> {
  return settleStorefrontPayment(runtimeDeps(), { ...s, table: STOREFRONT_ORDER_TABLE[orderType] })
}

/** /api/payments/verify for a cs_bill / cs_bundle payment. */
export async function verifyStorefrontPaymentRoute(
  orderType: StorefrontOrderType,
  payment: StorefrontPaymentRow,
  reference: string,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const d: VerifyDeps = {
    ...runtimeDeps(),
    async verifyPayment(ref) {
      const v = await verifyPayment(ref)
      return { status: v.status, amount: v.amount, transaction_id: v.transaction_id }
    },
  }
  return verifyStorefrontPayment(d, STOREFRONT_ORDER_TABLE[orderType], payment, reference)
}
