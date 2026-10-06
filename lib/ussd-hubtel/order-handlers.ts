// lib/ussd-hubtel/order-handlers.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderHandlers } from "./payment"
import { ORDER_TABLES } from "./order-tables"

const last9 = (p: string | null | undefined) => (p || "").replace(/\D/g, "").slice(-9)

async function ussdOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase.from("ussd_orders").select("*").eq("id", orderId).maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] ussd_orders lookup failed:", orderId, lookupErr)
  if (!order) throw new Error(`ussd_orders ${orderId} not found`)
  if (order.payment_status === "completed") return // already processed

  // Mark paid; order_status stays pending until fulfilment resolves (same as the Paystack path).
  const { data: marked, error: markErr } = await supabase
    .from("ussd_orders")
    .update({ payment_status: "completed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("payment_status", ["pending", "otp_required"])
    .select("id")
  if (markErr) throw markErr
  if (!marked || marked.length === 0) {
    throw new Error(`ussd_orders ${orderId} not in a payable state: ${order.payment_status}`)
  }

  let fulfillResult: { success: boolean; message: string; held?: boolean } | undefined
  try {
    const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
    fulfillResult = await fulfillUssdOrder(orderId, order.network, order.recipient_phone, order.package_size ?? "")
    if (!fulfillResult.success) console.error("[HUBTEL-ORDER] USSD fulfilment failed:", fulfillResult.message)
  } catch (e) {
    console.error("[HUBTEL-ORDER] Failed to trigger USSD fulfilment:", e)
    await supabase.from("ussd_orders").update({ order_status: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
  }

  if (order.parent_shop_id && Number(order.parent_profit_amount) > 0) {
    const { error: profitErr } = await supabase.from("shop_profits").insert([{
      shop_id: order.parent_shop_id,
      ussd_order_id: orderId,
      profit_amount: order.parent_profit_amount,
      status: "credited",
      created_at: new Date().toISOString(),
    }])
    if (profitErr) console.error("[HUBTEL-ORDER] Failed to insert parent profit:", profitErr)
  }

  const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
  if (!fulfillResult?.held) {
    try {
      const { getJoinCommunityLink } = await import("@/lib/app-settings")
      await sendSMS({
        phone: order.recipient_phone,
        message: SMSTemplates.ussdOrderConfirmed(order.package_size, order.network, await getJoinCommunityLink()),
        type: "order_confirmation",
        reference: orderId,
      })
    } catch (e) { console.warn("[HUBTEL-ORDER] recipient SMS failed:", e) }
  }
  if (order.dialing_phone && last9(order.dialing_phone) && last9(order.dialing_phone) !== last9(order.recipient_phone)) {
    try {
      await sendSMS({
        phone: order.dialing_phone,
        message: SMSTemplates.ussdPaymentConfirmed(
          order.package_size, order.network,
          order.recipient_phone?.slice(-4).padStart(order.recipient_phone.length, "*") ?? ""
        ),
        type: "order_confirmation",
        reference: orderId,
      })
    } catch (e) { console.warn("[HUBTEL-ORDER] payer SMS failed:", e) }
  }
}

/**
 * Mirrors the Paystack webhook's USSD airtime branch (app/api/webhooks/paystack/route.ts, "Handle
 * USSD airtime orders"). markAirtimeOrderPaid is that branch's own post-payment path (mark paid,
 * shop profit, customer tracking, Digiwapy or a manual-airtime admin alert) and is its own
 * idempotency gate, so it is called after a read-check rather than a conditional pre-mark (which
 * would make it no-op). Once-only is guaranteed by processFulfillment's claim on this order's
 * single tx row. WhatsApp-shop token deduction does not apply: channel is "ussd".
 */
async function airtimeOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from("airtime_orders")
    .select("id, payment_status, beneficiary_phone, dialing_phone, network, airtime_amount")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] airtime_orders lookup failed:", orderId, lookupErr)
  if (!order) throw new Error(`airtime_orders ${orderId} not found`)
  if (order.payment_status === "completed") return // already processed
  if (!ORDER_TABLES.airtime_orders.payableStatuses.includes(order.payment_status)) {
    throw new Error(`airtime_orders ${orderId} not in a payable state: ${order.payment_status}`)
  }

  const { markAirtimeOrderPaid } = await import("@/lib/airtime-service")
  const marked = await markAirtimeOrderPaid(orderId, null)
  if (!marked.success) throw new Error(`airtime_orders ${orderId} could not be marked paid`)
  if (marked.alreadyProcessed) return

  // Same message as the Paystack branch: airtime may be fulfilled manually, so never claim it landed.
  const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
  const benef = String(order.beneficiary_phone)
  const msg = SMSTemplates.ussdAirtimePaymentReceived(Number(order.airtime_amount).toFixed(2), order.network, benef)
  try {
    await sendSMS({ phone: benef, message: msg, type: "airtime_order_created", reference: orderId })
  } catch (e) { console.warn("[HUBTEL-ORDER] airtime recipient SMS failed:", e) }
  const payer = order.dialing_phone as string | null
  if (payer && last9(payer) && last9(payer) !== last9(benef)) {
    try {
      await sendSMS({ phone: payer, message: msg, type: "airtime_order_created", reference: orderId })
    } catch (e) { console.warn("[HUBTEL-ORDER] airtime payer SMS failed:", e) }
  }
}

/**
 * Mirrors the Paystack webhook's USSD results-checker branch. The atomic pending→completed
 * payment mark is the once-only gate; fulfillPaidResultsCheckerOrder then assigns, finalises and
 * SMSes the vouchers (it checks `status`, not payment_status, so the pre-mark does not block it).
 * Stock exhausted after payment ⇒ throw ⇒ needs_review (the Paystack path leaves it silently
 * pending): a human must deliver the vouchers.
 */
async function rcOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from("results_checker_orders")
    .select("id, status, payment_status")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] results_checker_orders lookup failed:", orderId, lookupErr)
  if (!order) throw new Error(`results_checker_orders ${orderId} not found`)
  if (order.status === "completed") return // already processed
  const payable = ORDER_TABLES.results_checker_orders.payableStatuses
  if (order.status === "failed" || !payable.includes(order.payment_status)) {
    throw new Error(`results_checker_orders ${orderId} not in a payable state: ${order.status}/${order.payment_status}`)
  }

  const { data: marked, error: markErr } = await supabase
    .from("results_checker_orders")
    .update({ payment_status: "completed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("payment_status", [...payable])
    .select("id")
  if (markErr) throw markErr
  if (!marked || marked.length === 0) throw new Error(`results_checker_orders ${orderId} not in a payable state (lost the mark)`)

  const { fulfillPaidResultsCheckerOrder } = await import("@/lib/results-checker-service")
  const result = await fulfillPaidResultsCheckerOrder(orderId)
  if (result.status === "pending") {
    throw new Error(`results_checker_orders ${orderId} paid but out of stock: deliver the vouchers manually`)
  }
  if (!result.success) throw new Error(`results_checker_orders ${orderId} fulfilment failed: ${result.message}`)
}

/**
 * Post-payment for a "Check Results" request. Uses fulfillPaidResultsCheckRequest (the storefront
 * path): marks paid, assigns the combo voucher, notifies admins, SMSes the caller and WhatsApps the
 * number they gave, which suits USSD callers better than the Paystack WhatsApp-bot branch (that one
 * WhatsApps phone_number only). It is its own idempotency gate (payment_status 'paid'), so it is
 * called after a read-check; once-only comes from processFulfillment's claim on this request's
 * single tx row. A combo paid with no voucher left in stock throws => needs_review.
 */
async function checkRequestPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: request, error: lookupErr } = await supabase
    .from("results_check_requests")
    .select("id, payment_status, status, mode")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] results_check_requests lookup failed:", orderId, lookupErr)
  if (!request) throw new Error(`results_check_requests ${orderId} not found`)
  if (request.payment_status === "paid") return // already processed
  const payable = ORDER_TABLES.results_check_requests.payableStatuses
  if (request.status === "failed" || !payable.includes(request.payment_status)) {
    throw new Error(`results_check_requests ${orderId} not in a payable state: ${request.status}/${request.payment_status}`)
  }

  const { fulfillPaidResultsCheckRequest } = await import("@/lib/results-checker-service")
  const result = await fulfillPaidResultsCheckRequest(orderId)
  if (!result.success) throw new Error(`results_check_requests ${orderId} not marked paid: ${result.message}`)

  // The library does not check the error on its own update yet still notifies the customer, so
  // verify the row really reached 'paid' (both modes) before calling this fulfilled.
  const { data: after } = await supabase
    .from("results_check_requests")
    .select("id, payment_status, voucher_pin")
    .eq("id", orderId)
    .maybeSingle()
  if (after?.payment_status !== "paid") {
    throw new Error(`results_check_requests ${orderId} not paid after fulfilment (still ${after?.payment_status ?? "unreadable"}): needs manual review`)
  }
  if (request.mode === "combo" && !after.voucher_pin) {
    throw new Error(`results_check_requests ${orderId} paid (combo) but no voucher was in stock: assign one manually`)
  }
}

export function createOrderHandlers(supabase: SupabaseClient): OrderHandlers {
  return {
    ussd_orders: orderId => ussdOrderPostPayment(supabase, orderId),
    airtime_orders: orderId => airtimeOrderPostPayment(supabase, orderId),
    results_checker_orders: orderId => rcOrderPostPayment(supabase, orderId),
    results_check_requests: orderId => checkRequestPostPayment(supabase, orderId),
    // Plan 3 registers ussd_shop_orders
  }
}

/** Used when an AddToCart never gets paid (definite expiry, or an admin "not paid" resolution). */
export function createFailHandlers(supabase: SupabaseClient): OrderHandlers {
  const handlers: OrderHandlers = {}
  for (const [table, spec] of Object.entries(ORDER_TABLES)) {
    handlers[table] = async orderId => {
      // Only an order that is still unpaid may be failed: a paid order is never touched here.
      const { error } = await supabase
        .from(table)
        .update(spec.failPatch())
        .eq("id", orderId)
        .in("payment_status", [...spec.payableStatuses])
      if (error) console.error("[HUBTEL-ORDER] fail handler update error:", table, orderId, error)
    }
  }
  return handlers
}
