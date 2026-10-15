// lib/ussd-hubtel/order-handlers.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { hubtelPaymentRef, type OrderHandlers, type PaidReviewHandlers } from "./payment"
import { ORDER_TABLES, isHubtelOrderTable, type HubtelOrderTable } from "./order-tables"
import { isPaidOutcome, type ConfirmPayment, type ConfirmResult } from "@/lib/storefront-commission/confirm"
import { markCommissionOrderPaid } from "@/lib/storefront-commission/mark-paid"
import type { StorefrontOrderTable } from "@/lib/storefront-commission/payment"
import { safeDbError } from "./log-safe"

const last9 = (p: string | null | undefined) => (p || "").replace(/\D/g, "").slice(-9)

async function ussdOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase.from("ussd_orders").select("*").eq("id", orderId).maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] ussd_orders lookup failed:", orderId, safeDbError(lookupErr))
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
    console.error("[HUBTEL-ORDER] Failed to trigger USSD fulfilment:", safeDbError(e))
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
    if (profitErr) console.error("[HUBTEL-ORDER] Failed to insert parent profit:", safeDbError(profitErr))
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
    } catch (e) { console.warn("[HUBTEL-ORDER] recipient SMS failed:", safeDbError(e)) }
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
    } catch (e) { console.warn("[HUBTEL-ORDER] payer SMS failed:", safeDbError(e)) }
  }
}

/**
 * Mirrors the Paystack webhook's USSD airtime branch (app/api/webhooks/paystack/route.ts, "Handle
 * USSD airtime orders"). markAirtimeOrderPaid is that branch's own post-payment path (mark paid,
 * shop profit, customer tracking, Digiwapy or a manual-airtime admin alert) and is its own
 * idempotency gate, so it is called after a read-check rather than a conditional pre-mark (which
 * would make it no-op). Once-only is guaranteed by processFulfillment's claim on this order's
 * single tx row. WhatsApp-shop token deduction does not apply: channel is 'ussd' (main menu) or
 * 'ussd_shop' (shop code, billed at code entry), never 'whatsapp_shop'.
 * Shop rows: the library credits merchant_commission to shop_id itself but swallows that insert's
 * error, so after the customer SMS the handler verifies the credit exists and otherwise THROWS
 * (=> needs_review) so a lost commission is never silent.
 */
async function airtimeOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from("airtime_orders")
    .select("id, payment_status, beneficiary_phone, dialing_phone, network, airtime_amount, shop_id, merchant_commission")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] airtime_orders lookup failed:", orderId, safeDbError(lookupErr))
  if (!order) throw new Error(`airtime_orders ${orderId} not found`)
  if (order.payment_status === "completed") return // already processed
  if (!ORDER_TABLES.airtime_orders.payableStatuses.includes(order.payment_status)) {
    throw new Error(`airtime_orders ${orderId} not in a payable state: ${order.payment_status}`)
  }

  const { markAirtimeOrderPaid } = await import("@/lib/airtime-service")
  const marked = await markAirtimeOrderPaid(orderId, null)
  if (!marked.success) throw new Error(`airtime_orders ${orderId} could not be marked paid`)
  if (marked.alreadyProcessed) return

  // The library ignores the error on its own payment_status update (and still triggers delivery),
  // so its success is not trusted: re-read the row and refuse to call this fulfilled (or SMS the
  // customer) unless it really reached 'completed'. Otherwise the expire-stale-airtime cron could
  // later expire a paid order. Fail closed on a read error or a missing row.
  const { data: after, error: afterErr } = await supabase
    .from("airtime_orders")
    .select("id, payment_status")
    .eq("id", orderId)
    .maybeSingle()
  if (afterErr) console.error("[HUBTEL-ORDER] airtime_orders re-read failed:", orderId, safeDbError(afterErr))
  if (after?.payment_status !== "completed") {
    throw new Error(`airtime_orders ${orderId} not marked paid after markAirtimeOrderPaid (still ${afterErr ? "unreadable" : after?.payment_status ?? "unreadable"}): needs manual review`)
  }

  // Same message as the Paystack branch: airtime may be fulfilled manually, so never claim it landed.
  const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
  const benef = String(order.beneficiary_phone)
  const msg = SMSTemplates.ussdAirtimePaymentReceived(Number(order.airtime_amount).toFixed(2), order.network, benef)
  try {
    await sendSMS({ phone: benef, message: msg, type: "airtime_order_created", reference: orderId })
  } catch (e) { console.warn("[HUBTEL-ORDER] airtime recipient SMS failed:", safeDbError(e)) }
  const payer = order.dialing_phone as string | null
  if (payer && last9(payer) && last9(payer) !== last9(benef)) {
    try {
      await sendSMS({ phone: payer, message: msg, type: "airtime_order_created", reference: orderId })
    } catch (e) { console.warn("[HUBTEL-ORDER] airtime payer SMS failed:", safeDbError(e)) }
  }

  // Checked AFTER the SMS: the top-up is under way, so the customer is told either way.
  if (order.shop_id && Number(order.merchant_commission) > 0) {
    const { data: credited, error: creditErr } = await supabase
      .from("shop_profits")
      .select("id")
      .eq("airtime_order_id", orderId)
      .eq("shop_id", order.shop_id)
      .limit(1)
    if (creditErr || !credited || credited.length === 0) {
      console.error("[HUBTEL-ORDER] shop commission missing for airtime order:", orderId, "shop:", order.shop_id,
        creditErr ? safeDbError(creditErr) : "no shop_profits row")
      throw new Error(`airtime_orders ${orderId}: airtime paid but shop commission not found in shop_profits: needs manual review`)
    }
  }
}

/**
 * Mirrors the Paystack webhook's USSD results-checker branch. The atomic pending→completed
 * payment mark is the once-only gate; fulfillPaidResultsCheckerOrder then assigns, finalises and
 * SMSes the vouchers (it checks `status`, not payment_status, so the pre-mark does not block it).
 * Stock exhausted after payment ⇒ throw ⇒ needs_review (the Paystack path leaves it silently
 * pending): a human must deliver the vouchers.
 * Shop rows (Plan 3, channel 'ussd_shop'): the library itself credits merchant_commission to shop_id
 * (shop_profits.results_checker_order_id) on delivery, the same single path the Paystack webhook
 * relies on, so the handler never writes a profit row. But that insert's error is swallowed (with an
 * un-linked fallback insert), so after a successful delivery the handler verifies the credit exists
 * and otherwise THROWS (customer already served) so the tx row lands in needs_review. Out of stock
 * after payment: the library credits nothing, so the admin delivers AND credits by hand (D14).
 * After a successful delivery the order's `status` is also re-read (the library swallows its own final
 * update error) and must be 'completed'; all post-delivery problems are thrown as ONE error.
 */
async function rcOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from("results_checker_orders")
    .select("id, status, payment_status, shop_id, merchant_commission")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] results_checker_orders lookup failed:", orderId, safeDbError(lookupErr))
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
  const owesCommission = !!order.shop_id && Number(order.merchant_commission) > 0
  if (result.status === "pending") {
    const credit = owesCommission ? " and credit the shop commission by hand" : ""
    throw new Error(`results_checker_orders ${orderId} paid but out of stock: deliver the vouchers manually${credit}`)
  }
  if (!result.success) throw new Error(`results_checker_orders ${orderId} fulfilment failed: ${result.message}`)

  // The customer has the PINs from here on. Collect every post-library problem and throw ONCE.
  const problems: string[] = []

  // The library swallows the error on its own final status update: re-read and require 'completed'
  // (otherwise the expire-stale-airtime cron could later expire a delivered, paid order).
  const { data: after, error: afterErr } = await supabase
    .from("results_checker_orders")
    .select("id, status")
    .eq("id", orderId)
    .maybeSingle()
  if (afterErr) console.error("[HUBTEL-ORDER] results_checker_orders re-read failed:", orderId, safeDbError(afterErr))
  if (afterErr || !after) problems.push("order unreadable after fulfilment")
  else if (after.status !== "completed") problems.push(`status '${after.status}' after fulfilment (vouchers sent)`)

  if (owesCommission) {
    const { data: credited, error: creditErr } = await supabase
      .from("shop_profits")
      .select("id")
      .eq("results_checker_order_id", orderId)
      .eq("shop_id", order.shop_id)
      .limit(1)
    if (creditErr) console.error("[HUBTEL-ORDER] shop_profits check failed for RC order:", orderId, safeDbError(creditErr))
    if (creditErr || !credited || credited.length === 0) {
      problems.push(
        "vouchers delivered but shop commission not found in shop_profits " +
        "(check for an un-linked fallback row before crediting by hand)"
      )
    }
  }

  if (problems.length > 0) throw new Error(`results_checker_orders ${orderId}: ${problems.join("; ")}: needs manual review`)
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
  if (lookupErr) console.error("[HUBTEL-ORDER] results_check_requests lookup failed:", orderId, safeDbError(lookupErr))
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

/**
 * fulfillment_status values lib/ussd/fulfill-afa.ts leaves behind on a SUCCESSFUL provider submission.
 * Everything else ('failed', a still-'unfulfilled' claim error, unexpected) is a failure.
 *  - 'fulfilled': Sykes accepted (line 141).
 *  - 'pending': Apex Prime accepted; the claim set 'pending' (line 63) and only fulfillment_ref is
 *    written on success (lines 96-108), so the sync cron confirms it later.
 */
export const OK_FULFILMENT_STATUSES: ReadonlySet<string> = new Set(["fulfilled", "pending"])

/**
 * Mirrors the Paystack webhook's USSD AFA branch: mark paid → fulfillUssdAfaOrder (it has its own
 * atomic fulfilment claim) → payer SMS. The mark is conditional (pending→completed) and is the
 * once-only gate. Shop-scoped rows are refused because that branch's inline shop-profit credit is
 * not ported (the Hubtel main router never sets shop_id). Provider failures are recorded by the
 * library in fulfillment_status only; no admin queue reads ussd_afa_orders, so the handler re-reads
 * fulfillment_status and, unless it is in OK_FULFILMENT_STATUSES, throws (=> needs_review for manual
 * follow-up; the Hubtel callback is still sent) without SMSing the payer.
 */
async function afaOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from("ussd_afa_orders")
    .select("id, payment_status, dialing_phone, shop_id")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] ussd_afa_orders lookup failed:", orderId, safeDbError(lookupErr))
  if (!order) throw new Error(`ussd_afa_orders ${orderId} not found`)
  if (order.payment_status === "completed") return // already processed
  const payable = ORDER_TABLES.ussd_afa_orders.payableStatuses
  if (!payable.includes(order.payment_status)) {
    throw new Error(`ussd_afa_orders ${orderId} not in a payable state: ${order.payment_status}`)
  }
  if (order.shop_id) throw new Error(`ussd_afa_orders ${orderId} is shop-scoped; not handled on the Hubtel main channel`)

  const { data: marked, error: markErr } = await supabase
    .from("ussd_afa_orders")
    .update({ payment_status: "completed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("payment_status", [...payable])
    .select("id")
  if (markErr) throw markErr
  if (!marked || marked.length === 0) throw new Error(`ussd_afa_orders ${orderId} not in a payable state (lost the mark)`)

  try {
    const { fulfillUssdAfaOrder } = await import("@/lib/ussd/fulfill-afa")
    const result = await fulfillUssdAfaOrder(orderId)
    if (!result.success) console.error("[HUBTEL-ORDER] AFA fulfilment failed:", orderId, result.message)
  } catch (e) {
    console.error("[HUBTEL-ORDER] Failed to trigger AFA fulfilment:", orderId, safeDbError(e))
  }

  // fulfillUssdAfaOrder records the provider outcome in fulfillment_status and never throws on a
  // provider failure, so its return value is not trusted: re-read the row. Anything outside
  // OK_FULFILMENT_STATUSES (failed, still unfulfilled, unreadable, unexpected) throws => needs_review
  // for manual follow-up, and the payer is NOT told the registration was received.
  const { data: after, error: afterErr } = await supabase
    .from("ussd_afa_orders")
    .select("id, fulfillment_status")
    .eq("id", orderId)
    .maybeSingle()
  if (afterErr) console.error("[HUBTEL-ORDER] ussd_afa_orders re-read failed:", orderId, safeDbError(afterErr))
  const fulfilment: unknown = after?.fulfillment_status
  if (typeof fulfilment !== "string" || !OK_FULFILMENT_STATUSES.has(fulfilment)) {
    throw new Error(`ussd_afa_orders ${orderId} paid but fulfillment_status is ${typeof fulfilment === "string" ? `'${fulfilment}'` : "unreadable"} after fulfilment: needs manual follow-up`)
  }

  const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
  try {
    await sendSMS({ phone: order.dialing_phone, message: SMSTemplates.ussdAfaPaymentReceived(), type: "order_confirmation", reference: orderId })
  } catch (e) { console.warn("[HUBTEL-ORDER] AFA payer SMS failed:", safeDbError(e)) }
}

/**
 * order_status values lib/ussd/fulfill.ts (with orderTable "ussd_shop_orders") can leave on a paid
 * shop order that is still being served:
 *  - 'pending': manual queue (auto-fulfilment off, unknown network, MTN provider failure) and the
 *    non-MTN path at return time (its provider call settles later and writes processing/pending);
 *    also what this handler writes when fulfillUssdOrder throws.
 *  - 'processing': placed with an MTN provider, awaiting the sync cron.
 *  - 'held_registration': lib/mtn-hold.ts HOLD_STATUS (number pending MTN registration).
 *  - 'completed': a provider webhook confirmed delivery before the re-read.
 * Anything else ('failed' = blacklisted recipient, unexpected, unreadable) is a paid order nobody
 * will serve, so the handler throws => needs_review.
 */
export const OK_SHOP_ORDER_STATUSES: ReadonlySet<string> = new Set(["pending", "processing", "held_registration", "completed"])

/**
 * Mirrors the Paystack webhook's ussd_shop_orders branch (app/api/webhooks/paystack/route.ts,
 * "Handle USSD shop orders"): conditional mark paid → shop profit → parent-shop profit → customer
 * tracking → fulfillUssdOrder(…, "ussd_shop_orders") → recipient SMS without the community link.
 * Profit amounts come from the stored row (snapshotted at confirm), never recomputed.
 * Deliberate differences (plan D10): no paystack_reference / payment_attempts (not a Paystack
 * payment; underpayment is decidePayment's job against expected_amount = the order amount); no
 * WhatsApp token deduction (only 'ussd_shop' rows are accepted, billed at code entry); a fulfilment
 * that THROWS leaves the order 'pending' for the manual queue (the webhook sets 'failed'); the post-
 * fulfilment row is re-read (the library ignores its own update errors) and the recipient is only
 * told "confirmed" when it is in OK_SHOP_ORDER_STATUSES; and a profit credit that failed, an
 * untriggered fulfilment or a bad post-state THROWS at the END (after the customer has been served)
 * so the tx row lands in needs_review instead of passing silently.
 * Once-only: the conditional mark below plus processFulfillment's claim on this order's single tx
 * row. A unique violation (23505) on shop_profits (migration 0108's (ussd_shop_order_id, shop_id) key,
 * a backstop until it is applied) is treated as already credited only when the existing row has the
 * expected amount; otherwise it is a problem. A parent shop equal to the shop is never credited twice.
 * A needs_review row is never re-run, so throwing late cannot double-credit.
 */
async function ussdShopOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase.from("ussd_shop_orders").select("*").eq("id", orderId).maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] ussd_shop_orders lookup failed:", orderId, safeDbError(lookupErr))
  if (!order) throw new Error(`ussd_shop_orders ${orderId} not found`)
  if (order.payment_status === "completed") {
    // Already processed (e.g. paid through another path): nothing to do, but never silently.
    console.warn("[HUBTEL-ORDER] ussd_shop_orders already completed; handler skipped:", orderId)
    return
  }
  // Only Hubtel shop-code rows: a whatsapp_shop row would need the per-order token deduction.
  if (order.channel != null && order.channel !== "ussd_shop") {
    throw new Error(`ussd_shop_orders ${orderId} has channel '${order.channel}', not handled on the Hubtel channel`)
  }

  // Once-only gate: only an order still unpaid can be marked paid; 0 rows => not payable.
  const payable = ORDER_TABLES.ussd_shop_orders.payableStatuses
  const { data: marked, error: markErr } = await supabase
    .from("ussd_shop_orders")
    .update({ payment_status: "completed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("payment_status", [...payable])
    .select("id")
  if (markErr) throw new Error(`ussd_shop_orders ${orderId} could not be marked paid: ${safeDbError(markErr).message}`)
  if (!marked || marked.length === 0) {
    throw new Error(`ussd_shop_orders ${orderId} not in a payable state: ${order.payment_status}`)
  }

  const problems: string[] = []
  const credit = async (shopId: string, amount: unknown, who: "shop" | "parent shop") => {
    const { error } = await supabase.from("shop_profits").insert([{
      shop_id: shopId,
      ussd_shop_order_id: orderId,
      profit_amount: amount,
      status: "credited",
      created_at: new Date().toISOString(),
    }])
    if (!error) return
    if (error.code === "23505") {
      // Migration 0108's (ussd_shop_order_id, shop_id) key says a credit exists: accept it only if
      // it is the amount this order owes, otherwise a human must look.
      console.warn(`[HUBTEL-ORDER] ${who} profit already credited (unique violation):`, orderId)
      const { data: existing, error: readErr } = await supabase
        .from("shop_profits")
        .select("id, profit_amount")
        .eq("ussd_shop_order_id", orderId)
        .eq("shop_id", shopId)
        .limit(1)
      if (readErr || !existing || existing.length === 0) {
        if (readErr) console.error(`[HUBTEL-ORDER] could not re-read existing ${who} profit:`, orderId, safeDbError(readErr))
        problems.push(`${who} profit: existing credit could not be verified after a unique violation`)
        return
      }
      const have = Number(existing[0].profit_amount)
      const want = Number(amount)
      if (!(Math.abs(have - want) <= 0.005)) {
        problems.push(`${who} profit already credited with a different amount (${have}, expected ${want})`)
      }
      return
    }
    const safe = safeDbError(error)
    console.error(`[HUBTEL-ORDER] Failed to credit ${who} profit:`, orderId, safe)
    problems.push(`${who} profit not credited (${safe.message})`)
  }
  // The shop's own margin (DB trigger syncs shop_available_balance). Zero/negative => no row (webhook).
  if (Number(order.profit_amount) > 0) await credit(order.shop_id, order.profit_amount, "shop")
  // Sub-agent orders: the parent shop's wholesale margin. A parent equal to the shop itself is bad
  // data (it would double-pay one shop, and collides with the shop's own credit under 0108's key):
  // skip it and flag the order for review.
  if (order.parent_shop_id && Number(order.parent_profit_amount) > 0) {
    if (order.parent_shop_id === order.shop_id) {
      console.error("[HUBTEL-ORDER] parent shop equals the shop on a shop order; parent credit skipped:", orderId, "shop:", order.shop_id)
      problems.push("parent shop is the shop itself: parent profit not credited")
    } else {
      await credit(order.parent_shop_id, order.parent_profit_amount, "parent shop")
    }
  }

  // Customer tracking, as the webhook. Non-fatal.
  try {
    const { customerTrackingService } = await import("@/lib/customer-tracking-service")
    await customerTrackingService.trackCustomer({
      shopId: order.shop_id,
      phoneNumber: order.recipient_phone,
      email: "",
      customerName: "USSD Customer", // channel is always ussd_shop on this path (checked above)
      totalPrice: Number(order.amount) || 0,
      slug: order.channel || "ussd_shop",
      orderId,
    })
  } catch (e) {
    console.error("[HUBTEL-ORDER] Customer tracking failed for shop order (non-fatal):", orderId, safeDbError(e))
  }

  let fulfillResult: { success: boolean; message: string; held?: boolean } | undefined
  try {
    const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
    // Trust the order_status fulfillUssdOrder sets; the re-read below verifies it.
    fulfillResult = await fulfillUssdOrder(orderId, order.network, order.recipient_phone, order.package_size ?? "", false, "ussd_shop_orders")
    if (!fulfillResult.success) console.error("[HUBTEL-ORDER] USSD shop fulfilment failed:", orderId, fulfillResult.held ? "held" : "not placed")
  } catch (e) {
    console.error("[HUBTEL-ORDER] Failed to trigger USSD shop fulfilment:", orderId, safeDbError(e))
    const { error: pendErr } = await supabase
      .from("ussd_shop_orders")
      .update({ order_status: "pending", updated_at: new Date().toISOString() })
      .eq("id", orderId)
    if (pendErr) console.error("[HUBTEL-ORDER] could not leave shop order pending:", orderId, safeDbError(pendErr))
    problems.push(`fulfilment could not be triggered (${safeDbError(e).message}); order left pending for manual fulfilment`)
  }

  // Post-state: the library swallows its own update errors, so verify the row really is paid and
  // in a state someone will serve. Fail closed on a read error or a missing row.
  const { data: after, error: afterErr } = await supabase
    .from("ussd_shop_orders")
    .select("id, payment_status, order_status")
    .eq("id", orderId)
    .maybeSingle()
  if (afterErr) console.error("[HUBTEL-ORDER] ussd_shop_orders re-read failed:", orderId, safeDbError(afterErr))
  let postOk = false
  if (afterErr || !after) {
    problems.push("order unreadable after fulfilment")
  } else if (after.payment_status !== "completed") {
    problems.push(`payment_status '${after.payment_status}' after fulfilment`)
  } else if (typeof after.order_status !== "string" || !OK_SHOP_ORDER_STATUSES.has(after.order_status)) {
    problems.push(`order_status '${after.order_status}' after fulfilment: paid order not being served`)
  } else {
    postOk = true
  }

  // Recipient SMS (shop orders omit the community link); a held order already got the hold SMS.
  // Never "confirmed" for an order whose fulfilment threw or whose post-state is wrong.
  if (fulfillResult && !fulfillResult.held && postOk) {
    try {
      const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
      await sendSMS({
        phone: order.recipient_phone,
        message: SMSTemplates.ussdOrderConfirmed(order.package_size, order.network),
        type: "order_confirmation",
        reference: orderId,
      })
    } catch (e) { console.warn("[HUBTEL-ORDER] shop recipient SMS failed:", orderId, safeDbError(e)) }
  }

  if (problems.length > 0) throw new Error(`ussd_shop_orders ${orderId}: ${problems.join("; ")}: needs manual review`)
}

/** Bot commission confirmation (lib/storefront-commission/confirm-runtime.ts confirmBotPayment); injectable for tests. */
export type ConfirmBotFn = (table: StorefrontOrderTable, orderId: string, p: ConfirmPayment) => Promise<ConfirmResult>

const defaultConfirmBot: ConfirmBotFn = async (table, orderId, p) => {
  const { confirmBotPayment } = await import("@/lib/storefront-commission/confirm-runtime")
  return confirmBotPayment(table, orderId, p)
}

/**
 * The payment facts for a bot order paid through the Hubtel checkout, from the hubtel_transactions row that
 * processFulfillment saved BEFORE running the handler (the most recently paid row for the order; paid_at, the Hubtel
 * OrderId and Hubtel's amounts are all saved first):
 * - reference: the Hubtel OrderId; a status-check payment may carry none, and the reference is then
 *   `hubtel-session:<session id>`, stable for that row (a retry confirms with the same reference, so the engine's
 *   replay / resume logic still recognises its own payment);
 * - amountAfterCharges: what Hubtel reports the merchant received for the cart (= the cart price; the customer pays
 *   Hubtel's charge on top). This is the amount the engine checks, pesewa-exact, against the order's paid_amount.
 */
async function hubtelPaymentFacts(
  supabase: SupabaseClient, table: StorefrontOrderTable, orderId: string,
): Promise<{ reference: string; amountAfterCharges: number | null }> {
  const { data, error } = await supabase
    .from("hubtel_transactions")
    .select("session_id, hubtel_order_id, amount_after_charges, paid_at")
    .eq("order_table", table)
    .eq("order_id", orderId)
    .not("paid_at", "is", null)
    .order("paid_at", { ascending: false })
    .limit(1)
  if (error) throw new Error(`${table} ${orderId}: hubtel_transactions read failed: ${safeDbError(error).message}`)
  const tx = data?.[0] as { session_id: string; hubtel_order_id: string | null; amount_after_charges: number | string | null } | undefined
  if (!tx) throw new Error(`${table} ${orderId}: no paid hubtel_transactions row found`)
  const amt = tx.amount_after_charges == null ? NaN : Number(tx.amount_after_charges)
  return { reference: hubtelPaymentRef(tx.hubtel_order_id, tx.session_id), amountAfterCharges: Number.isFinite(amt) ? amt : null }
}

/** failure_reason prefix of a PAID bot order held for a human (refund it, or deliver it by hand). */
export const BOT_NEEDS_REVIEW_PREFIX = "needs review:"

/**
 * Record a successful Hubtel payment on a bot commission order that will NOT be confirmed or dispatched (the payment
 * is held for review): one guarded update (markCommissionOrderPaid, channel 'bots', `payment_status = 'unpaid'` only)
 * sets payment_status 'paid', paid_at, payment_reference, status 'failed' and failure_reason "needs review: …".
 * The order is then refundable through /admin/refunds (failed + paid, channel bots) and is never dispatched (dispatch
 * needs a pending order). No shop share is credited. When the engine already flipped the order paid, this is a no-op
 * (0 rows) and touches nothing, so it can never double-credit or un-dispatch anything. Returns rows changed.
 */
export async function recordBotPaymentForReview(
  supabase: SupabaseClient,
  table: StorefrontOrderTable,
  orderId: string,
  p: { reference: string; reason: string },
): Promise<number> {
  const now = new Date().toISOString()
  const n = await markCommissionOrderPaid(supabase, table, orderId, { paid_at: now, payment_reference: p.reference }, {
    channels: ["bots"],
    extra: { status: "failed", failure_reason: `${BOT_NEEDS_REVIEW_PREFIX} ${p.reason}. Not sent: refund it or deliver it by hand.` },
  })
  if (n > 0) console.error("[HUBTEL-ORDER] paid bot order held for review (marked paid + failed, not sent):", table, orderId, p.reason)
  return n
}

/** Recorders for processFulfillment's held-without-handler paths (late success, underpayment): bot tables only. */
export function createPaidReviewHandlers(supabase: SupabaseClient): PaidReviewHandlers {
  return {
    hubtel_bill_orders: async (orderId, p) => { await recordBotPaymentForReview(supabase, "hubtel_bill_orders", orderId, p) },
    hubtel_data_orders: async (orderId, p) => { await recordBotPaymentForReview(supabase, "hubtel_data_orders", orderId, p) },
  }
}

/**
 * Commission Cashback bot order (Utility Bill / Network Plan) paid through the Hubtel USSD checkout. The order was
 * created by the engine (channel 'bots'); payment goes through the engine's shared confirmation: guarded unpaid ->
 * paid once, the shop share once (shop mode only; main-mode rows carry no shop), one Hubtel POST, resumable.
 * paidAmount = Hubtel's amount_after_charges for this payment, so the engine's pesewa-exact check against the order's
 * paid_amount is a real check (processFulfillment's decidePayment ran first, against expected_amount).
 * Outcomes confirmed / resumed / already_processed are fine for the callback; anything else (refused,
 * amount_mismatch, error) records the payment on the order for review (recordBotPaymentForReview: paid + failed
 * "needs review: …", never sent, refundable) and THROWS so the tx row lands in needs_review. So does a payment for an
 * unpaid order that is no longer pending (the orphan race, finding 3): the engine is not called for it. A dispatch
 * problem after a normal flip is alerted by the engine and is not a needs_review.
 */
async function botCommissionPostPayment(
  supabase: SupabaseClient,
  table: StorefrontOrderTable,
  orderId: string,
  confirmBot: ConfirmBotFn,
): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from(table)
    .select("id, channel, status, payment_status, paid_amount")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) throw new Error(`${table} ${orderId} lookup failed: ${safeDbError(lookupErr).message}`)
  if (!order) throw new Error(`${table} ${orderId} not found`)
  if (order.channel !== "bots") throw new Error(`${table} ${orderId} has channel '${order.channel}', not a bot order`)

  const { reference, amountAfterCharges } = await hubtelPaymentFacts(supabase, table, orderId)
  /** Record the payment on the order (best effort), then throw => needs_review. */
  const holdForReview = async (reason: string): Promise<never> => {
    try {
      await recordBotPaymentForReview(supabase, table, orderId, { reference, reason })
    } catch (e) {
      console.error("[HUBTEL-ORDER] could not record the held payment on the bot order:", table, orderId, safeDbError(e))
    }
    throw new Error(`${table} ${orderId}: ${reason}: needs manual review`)
  }

  const expected = Number(order.paid_amount)
  if (order.paid_amount == null || !Number.isFinite(expected) || expected <= 0) {
    return holdForReview(`order has no valid paid_amount (${String(order.paid_amount)})`)
  }
  if (amountAfterCharges == null) return holdForReview("no Hubtel amount recorded for the payment")

  // An unpaid order that is no longer pending (failed by the orphan fail racing this cart, or by hand) is never sent:
  // record the payment for review instead of asking the engine to flip it.
  if (order.payment_status === "unpaid" && order.status !== "pending") {
    return holdForReview(`Hubtel payment arrived after the order was ${String(order.status)}`)
  }

  const r = await confirmBot(table, orderId, { paidAmount: amountAfterCharges, reference })
  if (!isPaidOutcome(r.outcome)) return holdForReview(`bot payment confirmation returned '${r.outcome}'`)
}

export function createOrderHandlers(supabase: SupabaseClient, opts: { confirmBot?: ConfirmBotFn } = {}): OrderHandlers {
  const confirmBot = opts.confirmBot ?? defaultConfirmBot
  return {
    ussd_afa_orders: orderId => afaOrderPostPayment(supabase, orderId),
    ussd_orders: orderId => ussdOrderPostPayment(supabase, orderId),
    ussd_shop_orders: orderId => ussdShopOrderPostPayment(supabase, orderId),
    airtime_orders: orderId => airtimeOrderPostPayment(supabase, orderId),
    results_checker_orders: orderId => rcOrderPostPayment(supabase, orderId),
    results_check_requests: orderId => checkRequestPostPayment(supabase, orderId),
    hubtel_bill_orders: orderId => botCommissionPostPayment(supabase, "hubtel_bill_orders", orderId, confirmBot),
    hubtel_data_orders: orderId => botCommissionPostPayment(supabase, "hubtel_data_orders", orderId, confirmBot),
  }
}

/**
 * The guarded fail update: only an order still in a payable status (and matching the table's failGuards) is
 * failed, so a paid order is never touched. Returns the filtered update builder (await it, or add `.select`).
 */
function guardedFailUpdate(supabase: SupabaseClient, table: HubtelOrderTable, orderId: string) {
  const spec = ORDER_TABLES[table]
  let q = supabase
    .from(table)
    .update(spec.failPatch())
    .eq("id", orderId)
    .in("payment_status", [...spec.payableStatuses])
  for (const [col, vals] of Object.entries(spec.failGuards ?? {})) q = q.in(col, [...vals])
  return q
}

/** Used when an AddToCart never gets paid (definite expiry, or an admin "not paid" resolution). */
export function createFailHandlers(supabase: SupabaseClient): OrderHandlers {
  const handlers: OrderHandlers = {}
  for (const table of Object.keys(ORDER_TABLES) as HubtelOrderTable[]) {
    handlers[table] = async orderId => {
      // Only an order that is still unpaid may be failed: a paid order is never touched here.
      const { error } = await guardedFailUpdate(supabase, table, orderId)
      if (error) console.error("[HUBTEL-ORDER] fail handler update error:", table, orderId, safeDbError(error))
    }
  }
  return handlers
}

/**
 * Strict variant of the fail handler, used by the admin "not paid" resolution only: the same guarded
 * update (only an order still in a payable status is failed), but an update error, a row that is no
 * longer unpaid, or an unknown table THROWS so the admin is told the order may still be payable.
 * The lenient createFailHandlers (status-check expiry) keeps its swallow-and-log behaviour.
 */
export async function failOrderStrict(supabase: SupabaseClient, table: string, orderId: string): Promise<void> {
  if (!isHubtelOrderTable(table)) throw new Error(`${table} has no fail patch: order ${orderId} left unchanged`)
  const { data, error } = await guardedFailUpdate(supabase, table, orderId).select("id")
  if (error) throw new Error(`${table} ${orderId} could not be marked failed: ${safeDbError(error).message}`)
  if (!data || data.length === 0) {
    throw new Error(`${table} ${orderId} is not in an unpaid state (missing, already failed, or paid): left unchanged`)
  }
}

export function createStrictFailHandlers(supabase: SupabaseClient): OrderHandlers {
  const handlers: OrderHandlers = {}
  for (const table of Object.keys(ORDER_TABLES)) {
    handlers[table] = orderId => failOrderStrict(supabase, table, orderId)
  }
  return handlers
}
