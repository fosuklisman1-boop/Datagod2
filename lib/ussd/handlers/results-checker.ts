import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession } from "../types"
import { cont, end, mainMenu, rcMenu, rcBoardMenu, rcQtyPrompt, rcConfirmMenu, rcPaymentMethodMenu, rcMyVouchersMenu, rcVoucherDetailMenu } from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "../resolve-email"
import { resolveDialer } from "../resolve-dialer"
import { chargeMobileMoney } from "../../paystack"
import { paystackProviderFromPhone } from "../paystack-provider"
import { secureReference } from "../../secure-random"
import { sendSMS, SMSTemplates } from "../../sms-service"
import {
  isExamBoardEnabled, getAvailableCount, getMaxQuantity, calculateRCPrice,
  purchaseResultsCheckerVouchers, getRCBulkHint, type ExamBoard,
} from "../../results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ALL_BOARDS: ExamBoard[] = ["WAEC", "BECE", "NOVDEC"]

function toLocal(phone: string): string {
  if (phone.startsWith("+233")) return "0" + phone.slice(4)
  if (phone.startsWith("233")) return "0" + phone.slice(3)
  return phone
}

/** Boards that are both enabled and currently in stock (for the menu). */
export async function buildRcBoardOptions(): Promise<string[]> {
  const boards = await Promise.all(
    ALL_BOARDS.map(async (b) => {
      const [enabled, avail] = await Promise.all([isExamBoardEnabled(b), getAvailableCount(b)])
      return enabled && avail > 0 ? b : null
    })
  )
  return boards.filter((b): b is ExamBoard => b !== null)
}

// ── RC_SELECT_BOARD ───────────────────────────────────────────────────────────
export async function handleRcSelectBoard(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { step: "MAIN", dialingPhone: session.dialingPhone })
    return cont(mainMenu())
  }

  const options = session.rcBoardOptions ?? []
  const idx = parseInt(input.trim(), 10) - 1
  const board = options[idx]
  if (!board) return cont(rcBoardMenu(options))

  const [avail, max, bulkHint] = await Promise.all([getAvailableCount(board as ExamBoard), getMaxQuantity(), getRCBulkHint(board as ExamBoard)])
  const bulkForMenu = bulkHint ? { minQty: bulkHint.minQty, unitPrice: bulkHint.bulkBasePrice } : null
  await setSession(sessionId, { ...session, step: "RC_ENTER_QTY", rcBoard: board })
  return cont(rcQtyPrompt(board, avail, max, bulkForMenu))
}

// ── RC_ENTER_QTY ──────────────────────────────────────────────────────────────
export async function handleRcEnterQty(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "RC_SELECT_BOARD" })
    return cont(rcBoardMenu(session.rcBoardOptions ?? []))
  }

  const board = session.rcBoard! as ExamBoard
  const [avail, max, bulkHint] = await Promise.all([getAvailableCount(board), getMaxQuantity(), getRCBulkHint(board)])
  const bulkForMenu = bulkHint ? { minQty: bulkHint.minQty, unitPrice: bulkHint.bulkBasePrice } : null
  const cap = Math.min(avail, max)
  const qty = parseInt(input.trim(), 10)
  if (isNaN(qty) || qty < 1 || qty > cap) {
    return cont(`Enter a valid quantity.\n` + rcQtyPrompt(board, avail, max, bulkForMenu))
  }

  const pricing = await calculateRCPrice({ examBoard: board, quantity: qty, applyBulk: true })
  const dialer = await resolveDialer(session.dialingPhone ?? "")

  await setSession(sessionId, {
    ...session,
    step: "RC_CONFIRM",
    rcQty: qty,
    rcUnitPrice: pricing.unitPrice,
    rcTotal: pricing.totalPaid,
    userId: dialer.userId,
    walletBalance: dialer.balance,
  })

  const confirmText = rcConfirmMenu(board, qty, pricing.totalPaid, session.dialingPhone!)
  const bulkNote = pricing.bulkApplied ? ` (bulk rate GHS ${pricing.unitPrice.toFixed(2)}/ea)` : ""
  return cont(confirmText.replace("PIN(s) sent by SMS", `PIN(s) sent by SMS${bulkNote}`))
}

// ── RC_CONFIRM ────────────────────────────────────────────────────────────────
export async function handleRcConfirm(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "2") {
    await setSession(sessionId, { step: "MAIN", dialingPhone: session.dialingPhone })
    return end("Order cancelled.")
  }
  if (input.trim() !== "1") {
    return cont(rcConfirmMenu(session.rcBoard!, session.rcQty!, session.rcTotal!, session.dialingPhone!))
  }

  const board = session.rcBoard! as ExamBoard
  const qty = session.rcQty!
  const dialingPhone = session.dialingPhone!

  // Re-verify availability + price (stale-session guard)
  const [enabled, avail] = await Promise.all([isExamBoardEnabled(board), getAvailableCount(board)])
  if (!enabled || avail < qty) {
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end(`${board} vouchers are no longer available in that quantity. Please try again.`)
  }
  const pricing = await calculateRCPrice({ examBoard: board, quantity: qty, applyBulk: true })

  const dialer = await resolveDialer(dialingPhone)
  const provider = paystackProviderFromPhone(dialingPhone)
  const walletEligible = dialer.userId && dialer.balance !== undefined && dialer.balance >= pricing.totalPaid

  if (walletEligible) {
    await setSession(sessionId, {
      ...session,
      step: "RC_PAYMENT_METHOD",
      rcUnitPrice: pricing.unitPrice,
      rcTotal: pricing.totalPaid,
      userId: dialer.userId,
      walletBalance: dialer.balance,
    })
    return cont(rcPaymentMethodMenu(pricing.totalPaid, dialer.balance!))
  }

  if (!provider) {
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end("Payment not available for your number. Please use a MoMo number.")
  }

  await setSession(sessionId, {
    ...session,
    rcUnitPrice: pricing.unitPrice,
    rcTotal: pricing.totalPaid,
  })
  return createRcOrderAndChargeMomo(sessionId, session, board, qty, pricing.unitPrice, pricing.totalPaid, provider)
}

// ── RC_PAYMENT_METHOD ─────────────────────────────────────────────────────────
export async function handleRcPaymentMethod(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  const dialingPhone = session.dialingPhone!
  const board = session.rcBoard! as ExamBoard
  const qty = session.rcQty!
  const total = session.rcTotal!

  if (input.trim() === "0") {
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end("Order cancelled.")
  }

  if (input.trim() === "2") {
    const provider = paystackProviderFromPhone(dialingPhone)
    if (!provider) return end("Payment not available for your number.")
    return createRcOrderAndChargeMomo(sessionId, session, board, qty, session.rcUnitPrice!, total, provider)
  }

  if (input.trim() === "1") {
    const userId = session.userId!
    const dialer = await resolveDialer(dialingPhone)
    const localPhone = toLocal(dialingPhone)
    try {
      const { order, vouchers } = await purchaseResultsCheckerVouchers({ userId, examBoard: board, quantity: qty, applyBulk: true })

      // Tag the order as USSD + attach the caller's number for delivery/reporting
      await supabase.from("results_checker_orders")
        .update({ channel: "ussd", dialing_phone: dialingPhone, customer_phone: localPhone, updated_at: new Date().toISOString() })
        .eq("id", order.id)

      after(async () => {
        try {
          const { deliverVouchers } = await import("../../results-checker-notification-service")
          await deliverVouchers({ ...order, customer_phone: localPhone, customer_email: dialer.email ?? null }, vouchers)
        } catch (e) {
          console.warn("[USSD-RC] Wallet voucher delivery failed:", e)
        }
      })

      await setSession(sessionId, { step: "MAIN", dialingPhone })
      return end(`Success! Ref ${order.reference_code}.\n${board} voucher${qty > 1 ? "s" : ""} sent by SMS.`)
    } catch (err: any) {
      if (err?.code === "INSUFFICIENT_BALANCE") {
        return cont(`Insufficient balance.\nNeeded: GHS ${total.toFixed(2)}\n\n2. Pay via MoMo\n0. Cancel`)
      }
      if (err?.code === "INSUFFICIENT_INVENTORY") {
        await setSession(sessionId, { step: "MAIN", dialingPhone })
        return end("Vouchers sold out. Your wallet was not charged.")
      }
      console.error("[USSD-RC] Wallet purchase error:", err)
      await setSession(sessionId, { step: "MAIN", dialingPhone })
      return end("Error processing order. Please try again.")
    }
  }

  return cont(rcPaymentMethodMenu(total, session.walletBalance ?? 0))
}

// Creates a pending RC order and fires the MoMo prompt. The webhook assigns +
// delivers the vouchers (fulfillPaidResultsCheckerOrder) on charge.success.
async function createRcOrderAndChargeMomo(
  sessionId: string,
  session: USSDSession,
  board: ExamBoard,
  qty: number,
  unitPrice: number,
  total: number,
  provider: "mtn" | "vod" | "tgo"
): Promise<UzoResponse> {
  const dialingPhone = session.dialingPhone!
  const localDialing = toLocal(dialingPhone)
  const dialer = await resolveDialer(dialingPhone)

  const referenceCode = secureReference("RC", 2, 3)
  const { data: order, error: orderErr } = await supabase
    .from("results_checker_orders")
    .insert([{
      reference_code: referenceCode,
      exam_board: board,
      quantity: qty,
      customer_name: "USSD Customer",
      customer_email: dialer.email ?? null,
      customer_phone: localDialing,
      unit_price: unitPrice,
      fee_amount: 0,
      total_paid: total,
      shop_id: null,
      merchant_commission: 0,
      user_id: dialer.userId ?? null,
      status: "pending_payment",
      payment_status: "pending_payment",
      dialing_phone: dialingPhone,
      channel: "ussd",
    }])
    .select("id")
    .single()

  if (orderErr || !order) {
    console.error("[USSD-RC] Failed to create order:", orderErr)
    return end("Error creating order.\nPlease try again.")
  }

  const email = await resolveEmail(dialingPhone)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await chargeMobileMoney({
        email,
        amount: total,
        phone: dialingPhone,
        provider,
        reference: order.id,
        metadata: { source: "ussd_results_checker", results_checker_order_id: order.id, exam_board: board, quantity: qty },
      })
      try {
        await supabase.from("payment_attempts").insert({ reference: order.id, amount: total, email, status: "pending", payment_type: "ussd_results_checker", order_id: order.id })
      } catch (paErr) {
        console.warn("[USSD-RC] payment_attempts insert failed (non-fatal):", paErr)
      }
      console.log("[USSD-RC] ✓ Charge initiated:", order.id, "status:", status)
      if (status === "send_otp") {
        await supabase.from("results_checker_orders").update({ payment_status: "otp_required", updated_at: new Date().toISOString() }).eq("id", order.id)
        sendSMS({ phone: dialingPhone, message: SMSTemplates.ussdOtpRequired(), type: "otp_required", reference: order.id }).catch(() => {})
      }
    } catch (err) {
      console.error("[USSD-RC] Charge failed:", err)
      await supabase.from("results_checker_orders").update({ payment_status: "failed", status: "failed", updated_at: new Date().toISOString() }).eq("id", order.id)
    }
  })

  await setSession(sessionId, {
    ...session,
    pendingOrderId: order.id,
    pendingOrderTable: "results_checker_orders",
    step: "MAIN",
  })
  return end(`MoMo prompt sent to ${localDialing}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`)
}

// ── RC_MENU ───────────────────────────────────────────────────────────────────
export async function handleRcMenu(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  switch (input.trim()) {
    case '1': {
      const boards = await buildRcBoardOptions()
      if (boards.length === 0) return cont('No vouchers available\nright now.\n\n' + rcMenu())
      await setSession(sessionId, { ...session, step: 'RC_SELECT_BOARD', rcBoardOptions: boards })
      return cont(rcBoardMenu(boards))
    }
    case '2': {
      const dialingPhone = session.dialingPhone!
      const localPhone = toLocal(dialingPhone)
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: orders } = await supabase
        .from("results_checker_orders")
        .select("id, exam_board, reference_code, created_at")
        .or(`dialing_phone.eq.${dialingPhone},dialing_phone.eq.${localPhone},customer_phone.eq.${localPhone}`)
        .eq("status", "completed")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(5)
      const list = orders ?? []
      await setSession(sessionId, { ...session, step: 'RC_MY_VOUCHERS', rcMyOrders: list })
      return cont(rcMyVouchersMenu(list))
    }
    case '0':
      await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
      return cont(mainMenu())
    default:
      return cont(rcMenu())
  }
}

// ── RC_MY_VOUCHERS ────────────────────────────────────────────────────────────
export async function handleRcMyVouchers(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'RC_MENU' })
    return cont(rcMenu())
  }
  const orders = session.rcMyOrders ?? []
  const idx = parseInt(input.trim(), 10) - 1
  const order = orders[idx]
  if (!order) return cont(rcMyVouchersMenu(orders))

  await setSession(sessionId, { ...session, step: 'RC_VOUCHER_DETAIL', rcSelectedOrderId: order.id })
  return cont(rcVoucherDetailMenu(order.exam_board, order.reference_code, 0, order.created_at))
}

// ── RC_VOUCHER_DETAIL ─────────────────────────────────────────────────────────
export async function handleRcVoucherDetail(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'RC_MY_VOUCHERS' })
    return cont(rcMyVouchersMenu(session.rcMyOrders ?? []))
  }
  if (input.trim() !== '1') {
    const orders = session.rcMyOrders ?? []
    const order = orders.find(o => o.id === session.rcSelectedOrderId)
    if (order) return cont(rcVoucherDetailMenu(order.exam_board, order.reference_code, 0, order.created_at))
    return cont(rcMenu())
  }

  const orderId = session.rcSelectedOrderId!
  const dialingPhone = session.dialingPhone!
  const localPhone = toLocal(dialingPhone)

  const { resendVouchers } = await import("../../results-checker-notification-service")
  const result = await resendVouchers(orderId, "sms")

  if (!result.success) {
    return end(result.message.length < 100 ? result.message : "Resend failed. Please contact support.")
  }

  return end(`Vouchers sent to ${localPhone}.`)
}
