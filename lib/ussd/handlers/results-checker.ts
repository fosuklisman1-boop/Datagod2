import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession } from "../types"
import {
  cont, end, mainMenu, rcMenu, rcBoardMenu, rcQtyPrompt, rcConfirmMenu, rcPaymentMethodMenu,
  rcMyVouchersMenu, rcVoucherDetailMenu, rcCheckBoardMenu, rcCheckCandidateTypeMenu,
  rcCheckModeMenu, rcCheckVoucherPrompt,
  rcCheckIndexPrompt, rcCheckDobPrompt, rcCheckWaNumberPrompt, rcCheckYearPrompt,
  rcCheckConfirmMenu, rcCheckPaymentMethodMenu,
} from "../menus"
import { setSession } from "../session"
import { isValidDob } from "../../results-check-validation"
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

const ALL_BOARDS: ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]

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
    case '3': {
      const { enabled } = await getRcCheckSettings()
      if (!enabled) return cont('Service not available.\n\n' + rcMenu())
      await setSession(sessionId, { ...session, step: 'RC_CHECK_BOARD', rcCheckChannel: 'ussd' })
      return cont(rcCheckBoardMenu())
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

// ── Results Check Service ─────────────────────────────────────────────────────

async function getRcCheckSettings(): Promise<{ enabled: boolean; fee: number }> {
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "results_check_settings")
    .maybeSingle()
  const v = data?.value as any
  return {
    enabled: v?.enabled !== false,
    fee: typeof v?.fee === "number" ? v.fee : 2.00,
  }
}

// ── RC_CHECK_BOARD ────────────────────────────────────────────────────────────
export async function handleRcCheckBoard(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "RC_MENU" })
    return cont(rcMenu())
  }
  const boards = ["WASSCE", "BECE", "NOVDEC"]
  const idx = parseInt(input.trim(), 10) - 1
  const board = boards[idx]
  if (!board) return cont(rcCheckBoardMenu())

  const [{ fee: checkFee }, availCount] = await Promise.all([
    getRcCheckSettings(),
    getAvailableCount(board as ExamBoard),
  ])

  // Compute combo pricing now (even if 0 stock, we store fee for own_voucher path)
  let comboTotal: number | undefined
  if (availCount > 0) {
    const pricing = await calculateRCPrice({ examBoard: board as ExamBoard, quantity: 1, applyBulk: false })
    comboTotal = pricing.unitPrice + checkFee
  }

  await setSession(sessionId, {
    ...session,
    step: "RC_CHECK_CANDIDATE_TYPE",
    rcCheckBoard: board,
    rcCheckFee: checkFee,
    rcCheckComboTotal: comboTotal,
  })
  return cont(rcCheckCandidateTypeMenu())
}

// ── RC_CHECK_CANDIDATE_TYPE ───────────────────────────────────────────────────
export async function handleRcCheckCandidateType(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "RC_CHECK_BOARD" })
    return cont(rcCheckBoardMenu())
  }
  const t = input.trim()
  if (t !== "1" && t !== "2") return cont(rcCheckCandidateTypeMenu())
  const candidateType = t === "1" ? "school" : "private"

  const comboTotal = session.rcCheckComboTotal
  if (comboTotal !== undefined) {
    // Vouchers available — show mode selection
    await setSession(sessionId, { ...session, step: "RC_CHECK_MODE", rcCheckCandidateType: candidateType })
    return cont(rcCheckModeMenu(comboTotal, session.rcCheckFee ?? 2))
  }
  // No vouchers in stock — skip mode, force own_voucher
  await setSession(sessionId, { ...session, step: "RC_CHECK_VOUCHER", rcCheckCandidateType: candidateType, rcCheckMode: "own_voucher" })
  return cont("No vouchers in stock.\nProvide your own PIN.\n\n" + rcCheckVoucherPrompt())
}

// ── RC_CHECK_MODE ─────────────────────────────────────────────────────────────
export async function handleRcCheckMode(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "RC_CHECK_BOARD" })
    return cont(rcCheckBoardMenu())
  }
  const comboTotal = session.rcCheckComboTotal ?? 0
  const checkFee = session.rcCheckFee ?? 2
  if (input.trim() === "1") {
    await setSession(sessionId, { ...session, step: "RC_CHECK_INDEX", rcCheckMode: "combo" })
    return cont(rcCheckIndexPrompt())
  }
  if (input.trim() === "2") {
    await setSession(sessionId, { ...session, step: "RC_CHECK_VOUCHER", rcCheckMode: "own_voucher" })
    return cont(rcCheckVoucherPrompt())
  }
  return cont(rcCheckModeMenu(comboTotal, checkFee))
}

// ── RC_CHECK_VOUCHER ──────────────────────────────────────────────────────────
export async function handleRcCheckVoucher(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    const comboTotal = session.rcCheckComboTotal
    if (comboTotal !== undefined) {
      await setSession(sessionId, { ...session, step: "RC_CHECK_MODE" })
      return cont(rcCheckModeMenu(comboTotal, session.rcCheckFee ?? 2))
    }
    await setSession(sessionId, { ...session, step: "RC_CHECK_CANDIDATE_TYPE" })
    return cont(rcCheckCandidateTypeMenu())
  }
  // Accept "PIN/Serial", "PIN Serial", or "PIN,Serial"
  const raw = input.trim().toUpperCase()
  const parts = raw.split(/[\/,\s]+/)
  const pin = parts[0] ?? ''
  const serial = parts[1] ?? ''
  // PIN: exactly 12 digits. Serial: 1-4 letters followed by 7-15 digits (e.g. WGR1900112581)
  if (!pin || !serial || !/^\d{12}$/.test(pin) || !/^[A-Z]{1,4}\d{7,15}$/.test(serial)) {
    return cont("Invalid PIN or serial.\nPIN: 12 digits\nSerial: e.g. WGR1900112581\n\nFormat: PIN/Serial\ne.g. 012345678912/WGR1900112581\n\n0. Back")
  }
  await setSession(sessionId, {
    ...session,
    step: "RC_CHECK_INDEX",
    rcCheckVoucherPin: parts[0],
    rcCheckVoucherSerial: parts[1],
  })
  return cont(rcCheckIndexPrompt())
}

// ── RC_CHECK_INDEX ────────────────────────────────────────────────────────────
export async function handleRcCheckIndex(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    if (session.rcCheckMode === 'own_voucher') {
      await setSession(sessionId, { ...session, step: "RC_CHECK_VOUCHER" })
      return cont(rcCheckVoucherPrompt())
    }
    const comboTotal = session.rcCheckComboTotal
    if (comboTotal !== undefined) {
      await setSession(sessionId, { ...session, step: "RC_CHECK_MODE" })
      return cont(rcCheckModeMenu(comboTotal, session.rcCheckFee ?? 2))
    }
    await setSession(sessionId, { ...session, step: "RC_CHECK_CANDIDATE_TYPE" })
    return cont(rcCheckCandidateTypeMenu())
  }
  // WASSCE/NOVDEC: exactly 10 digits (7-digit centre + 3-digit candidate)
  // BECE: 10 digits (legacy) or 12 digits (school code + candidate + 2-digit year, adopted 2019)
  const index = input.trim().replace(/\s/g, '')
  const board = session.rcCheckBoard ?? ''
  const isBece = board === 'BECE'
  const valid = isBece ? /^\d{10}$|^\d{12}$/.test(index) : /^\d{10}$/.test(index)
  if (!valid) {
    const hint = isBece ? '10 or 12 digits' : 'exactly 10 digits'
    return cont(`Invalid index number.\nMust be ${hint},\nnumbers only.\ne.g. 0070202043\n\n0. Back`)
  }
  await setSession(sessionId, { ...session, step: "RC_CHECK_YEAR", rcCheckIndex: index })
  return cont(rcCheckYearPrompt())
}

// ── RC_CHECK_YEAR ─────────────────────────────────────────────────────────────
export async function handleRcCheckYear(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "RC_CHECK_INDEX" })
    return cont(rcCheckIndexPrompt())
  }
  const year = parseInt(input.trim(), 10)
  const currentYear = new Date().getFullYear()
  if (isNaN(year) || year < 1980 || year > currentYear) {
    return cont(`Invalid year.\nEnter a year between\n1980 and ${currentYear}.\n\n0. Back`)
  }
  await setSession(sessionId, { ...session, step: "RC_CHECK_DOB", rcCheckYear: year })
  return cont(rcCheckDobPrompt())
}

// ── RC_CHECK_DOB ──────────────────────────────────────────────────────────────
export async function handleRcCheckDob(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "RC_CHECK_YEAR" })
    return cont(rcCheckYearPrompt())
  }
  const dob = input.trim()
  // Accept DD/MM/YYYY or DD-MM-YYYY; validate it's a real past date.
  const normalised = dob.replace(/-/g, "/")
  if (!isValidDob(normalised)) {
    return cont("Invalid date.\nUse DD/MM/YYYY\ne.g. 15/06/2008\n\n0. Back")
  }
  const { fee } = await getRcCheckSettings()
  const dialer = await resolveDialer(session.dialingPhone ?? "")
  const balance = dialer.balance ?? 0
  const channel = session.rcCheckChannel ?? 'ussd'
  const nextStep = channel === 'ussd' ? 'RC_CHECK_WA_NUMBER' : 'RC_CHECK_CONFIRM'

  const updatedSession = {
    ...session,
    step: nextStep as USSDSession['step'],
    rcCheckDob: normalised,
    rcCheckFee: fee,
    userId: dialer.userId,
    walletBalance: balance,
  }
  await setSession(sessionId, updatedSession)

  if (channel === 'ussd') {
    return cont(rcCheckWaNumberPrompt())
  }

  return cont(rcCheckConfirmMenu(
    session.rcCheckBoard!,
    session.rcCheckCandidateType ?? 'school',
    session.rcCheckIndex!,
    normalised,
    session.rcCheckYear!,
    fee,
    balance,
    channel,
    session.rcCheckMode ?? 'own_voucher',
    session.rcCheckComboTotal,
    session.rcCheckVoucherPin,
    session.rcCheckVoucherSerial,
  ))
}

// ── RC_CHECK_WA_NUMBER ────────────────────────────────────────────────────────
export async function handleRcCheckWaNumber(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  const trimmed = input.trim()
  // WhatsApp number is mandatory — results (incl. image/PDF) are delivered there.
  if (!/^0[2345]\d{8}$/.test(trimmed) && !/^233[2345]\d{8}$/.test(trimmed)) {
    return cont('Invalid number.\nEnter your WhatsApp\nnumber (0XXXXXXXXX)\nto receive your results.')
  }
  const localWa = trimmed.startsWith('0') ? trimmed : '0' + trimmed.slice(3)
  const fee = session.rcCheckFee ?? 2
  const balance = session.walletBalance ?? 0
  await setSession(sessionId, {
    ...session,
    step: 'RC_CHECK_CONFIRM',
    rcCheckWaNumber: localWa,
  })
  return cont(rcCheckConfirmMenu(
    session.rcCheckBoard!,
    session.rcCheckCandidateType ?? 'school',
    session.rcCheckIndex!,
    session.rcCheckDob ?? '',
    session.rcCheckYear!,
    fee,
    balance,
    session.rcCheckChannel ?? 'ussd',
    session.rcCheckMode ?? 'own_voucher',
    session.rcCheckComboTotal,
    session.rcCheckVoucherPin,
    session.rcCheckVoucherSerial,
  ))
}

// ── RC_CHECK_CONFIRM ──────────────────────────────────────────────────────────
export async function handleRcCheckConfirm(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "RC_MENU" })
    return cont(rcMenu())
  }
  const mode = session.rcCheckMode ?? 'own_voucher'
  const fee = session.rcCheckFee ?? 2
  const comboTotal = session.rcCheckComboTotal ?? fee

  if (input.trim() !== "1") {
    return cont(rcCheckConfirmMenu(
      session.rcCheckBoard!,
      session.rcCheckCandidateType ?? 'school',
      session.rcCheckIndex!,
      session.rcCheckDob ?? '',
      session.rcCheckYear!,
      fee,
      session.walletBalance ?? 0,
      session.rcCheckChannel ?? 'ussd',
      mode, comboTotal,
      session.rcCheckVoucherPin,
      session.rcCheckVoucherSerial,
    ))
  }

  const userId = session.userId
  const amount = mode === 'combo' ? comboTotal : fee
  const dialingPhone = session.dialingPhone!
  const localPhone = toLocal(dialingPhone)
  const channel = session.rcCheckChannel ?? "ussd"

  if (!userId) {
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end("Please create an account\nto use this service.")
  }

  // For USSD channel: create a pending record and offer payment method choice
  if (channel === 'ussd') {
    const dialer = await resolveDialer(dialingPhone)
    const balance = dialer.balance ?? 0
    const provider = paystackProviderFromPhone(dialingPhone)
    const walletEligible = !!dialer.userId && balance >= amount

    if (!walletEligible && !provider) {
      return cont(
        `Insufficient wallet.\nNeeded: GHS ${amount.toFixed(2)}\nYours: GHS ${balance.toFixed(2)}\n\nTop up your wallet.\n0. Back`
      )
    }

    const referenceCode = secureReference("RCK", 2, 3)
    const { data: request, error: reqErr } = await supabase
      .from("results_check_requests")
      .insert([{
        phone_number: localPhone,
        exam_board: session.rcCheckBoard,
        candidate_type: session.rcCheckCandidateType ?? 'school',
        index_number: session.rcCheckIndex,
        dob: session.rcCheckDob ?? null,
        exam_year: session.rcCheckYear,
        fee: amount,
        payment_status: "pending_payment",
        status: "pending",
        channel,
        user_id: userId,
        payment_reference: referenceCode,
        mode,
        voucher_pin: mode === 'own_voucher' ? (session.rcCheckVoucherPin ?? null) : null,
        voucher_serial: mode === 'own_voucher' ? (session.rcCheckVoucherSerial ?? null) : null,
        whatsapp_number: session.rcCheckWaNumber ?? null,
      }])
      .select("id")
      .single()

    if (reqErr || !request) {
      console.error("[RC-CHECK] Failed to create pending request:", reqErr)
      return end("Error creating request.\nPlease try again.")
    }

    await setSession(sessionId, {
      ...session,
      step: "RC_CHECK_PAYMENT_METHOD",
      walletBalance: balance,
      userId: dialer.userId,
      pendingOrderId: request.id,
      pendingOrderTable: "results_check_requests",
    })
    return cont(rcCheckPaymentMethodMenu(amount, balance, !!provider))
  }

  // WA channel — only reached for non-'1' inputs (back/cancel); '1' is intercepted by WA router
  return cont(rcCheckConfirmMenu(
    session.rcCheckBoard!,
    session.rcCheckCandidateType ?? 'school',
    session.rcCheckIndex!,
    session.rcCheckDob ?? '',
    session.rcCheckYear!,
    fee,
    session.walletBalance ?? 0,
    channel,
    mode, comboTotal,
    session.rcCheckVoucherPin,
    session.rcCheckVoucherSerial,
  ))
}

// ── RC_CHECK_PAYMENT_METHOD ───────────────────────────────────────────────────
export async function handleRcCheckPaymentMethod(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  const orderId = session.pendingOrderId!
  const mode = session.rcCheckMode ?? 'own_voucher'
  const fee = session.rcCheckFee ?? 2
  const comboTotal = session.rcCheckComboTotal ?? fee
  const amount = mode === 'combo' ? comboTotal : fee
  const dialingPhone = session.dialingPhone!
  const provider = paystackProviderFromPhone(dialingPhone)

  if (input.trim() === "0") {
    await supabase.from("results_check_requests")
      .update({ payment_status: "failed", status: "failed", updated_at: new Date().toISOString() })
      .eq("id", orderId)
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end("Order cancelled.")
  }

  if (input.trim() === "2") {
    if (!provider) return cont("MoMo not available\nfor your number.\n\n0. Cancel")
    return chargeRcCheckMomo(sessionId, session, orderId, amount, provider)
  }

  if (input.trim() !== "1") {
    return cont(rcCheckPaymentMethodMenu(amount, session.walletBalance ?? 0, !!provider))
  }

  // Wallet payment — re-verify balance at payment time
  const userId = session.userId!
  const { data: walletRow } = await supabase.from("wallets").select("balance").eq("user_id", userId).maybeSingle()
  const balance = walletRow ? Number(walletRow.balance) : 0
  if (balance < amount) {
    return cont(
      `Insufficient balance.\nWallet: GHS ${balance.toFixed(2)}\nNeeded: GHS ${amount.toFixed(2)}\n\n` +
      (provider ? "2. Pay via MoMo\n" : "") +
      "0. Cancel"
    )
  }

  const { data: deductResult, error: deductError } = await supabase.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: amount,
  })
  if (deductError || !deductResult || deductResult.length === 0) {
    return cont(
      `Payment failed.\nWallet: GHS ${balance.toFixed(2)}\n\n` +
      (provider ? "2. Pay via MoMo\n" : "") +
      "0. Cancel"
    )
  }
  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

  // Assign combo voucher at payment time
  let voucherPin: string | null = null
  let voucherSerial: string | null = null
  if (mode === 'combo') {
    const { data: voucherRows } = await supabase
      .from("results_checker_inventory")
      .select("id, pin, serial_number")
      .eq("exam_board", session.rcCheckBoard!)
      .eq("status", "available")
      .limit(1)
    if (voucherRows && voucherRows.length > 0) {
      const v = voucherRows[0]
      await supabase.from("results_checker_inventory")
        .update({ status: "sold", updated_at: new Date().toISOString() })
        .eq("id", v.id)
      voucherPin = v.pin
      voucherSerial = v.serial_number ?? null
    }
  }

  const updateData: Record<string, unknown> = {
    payment_status: "paid",
    status: "pending",
    updated_at: new Date().toISOString(),
  }
  if (voucherPin) updateData.voucher_pin = voucherPin
  if (voucherSerial) updateData.voucher_serial = voucherSerial

  await supabase.from("results_check_requests").update(updateData).eq("id", orderId)

  const { notifyAdminsNewResultsCheckRequest } = await import("@/lib/results-checker-service")
  await notifyAdminsNewResultsCheckRequest(orderId).catch(e => console.warn("[RC-CHECK] Admin notify failed:", e))

  void supabase.from("wallet_transactions").insert({
    user_id: userId,
    type: "debit",
    source: "results_check_request",
    amount,
    balance_before: balanceBefore,
    balance_after: newBalance,
    description: `Results check: ${session.rcCheckBoard} ${session.rcCheckIndex} ${session.rcCheckYear}`,
    reference_id: orderId,
    status: "completed",
  })

  await setSession(sessionId, { step: "MAIN", dialingPhone })
  return end(
    `Payment successful!\nWe'll check your\n${session.rcCheckBoard} results and\nsend them to you shortly.`
  )
}

// Fires the MoMo prompt for USSD results check. Webhook completes on charge.success.
async function chargeRcCheckMomo(
  sessionId: string,
  session: USSDSession,
  requestId: string,
  amount: number,
  provider: "mtn" | "vod" | "tgo"
): Promise<UzoResponse> {
  const dialingPhone = session.dialingPhone!
  const localDialing = toLocal(dialingPhone)
  const email = await resolveEmail(dialingPhone)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await chargeMobileMoney({
        email,
        amount,
        phone: dialingPhone,
        provider,
        reference: requestId,
        metadata: {
          source: "ussd_results_check",
          results_check_request_id: requestId,
          exam_board: session.rcCheckBoard,
          index_number: session.rcCheckIndex,
          exam_year: session.rcCheckYear,
          mode: session.rcCheckMode,
        },
      })
      if (status === 'send_otp') {
        await supabase.from("results_check_requests")
          .update({ payment_status: "otp_required", updated_at: new Date().toISOString() })
          .eq("id", requestId)
      }
    } catch (err) {
      console.error("[RC-CHECK] MoMo charge failed:", err)
      await supabase.from("results_check_requests")
        .update({ payment_status: "failed", status: "failed", updated_at: new Date().toISOString() })
        .eq("id", requestId)
    }
  })

  await setSession(sessionId, {
    ...session,
    step: "SUBMIT_OTP",
    pendingOrderId: requestId,
    pendingOrderTable: "results_check_requests",
  })
  return cont(
    `MoMo prompt sent to\n${localDialing}.\nEnter OTP if prompted:\n\n0. Cancel`
  )
}

// ── WhatsApp MoMo path for Results Check ─────────────────────────────────────
// Called by the WA router when the user confirms. Creates a pending request
// and fires a MoMo charge. Delivery happens via the Paystack webhook.
export async function handleRcCheckConfirmMomo(
  sessionId: string,
  session: USSDSession,
): Promise<UzoResponse> {
  const mode = session.rcCheckMode ?? 'own_voucher'
  const fee = session.rcCheckFee ?? 2
  const amount = mode === 'combo' ? (session.rcCheckComboTotal ?? fee) : fee
  // dialingPhone was overwritten with the MoMo number at WA_ENTER_PAYMENT_PHONE;
  // sessionId IS the WhatsApp sender's phone for WA channel.
  const momoPhone = session.dialingPhone!
  const waPhone = toLocal(sessionId)  // original WhatsApp sender number
  const provider = paystackProviderFromPhone(momoPhone)

  if (!provider) {
    await setSession(sessionId, { ...session, step: "RC_CHECK_BOARD" })
    return end("MoMo payment not available\nfor this number.")
  }

  const referenceCode = secureReference("RCK", 2, 3)
  const { data: request, error } = await supabase
    .from("results_check_requests")
    .insert([{
      phone_number: waPhone,      // delivery goes to the WhatsApp sender
      exam_board: session.rcCheckBoard,
      candidate_type: session.rcCheckCandidateType ?? 'school',
      index_number: session.rcCheckIndex,
      dob: session.rcCheckDob ?? null,
      exam_year: session.rcCheckYear,
      fee: amount,
      payment_status: "pending_payment",
      status: "pending",
      channel: "whatsapp",
      user_id: session.userId ?? null,
      payment_reference: referenceCode,
      mode,
      voucher_pin: mode === 'own_voucher' ? (session.rcCheckVoucherPin ?? null) : null,
      voucher_serial: mode === 'own_voucher' ? (session.rcCheckVoucherSerial ?? null) : null,
      whatsapp_number: waPhone,   // same: the WA sender is both contact and delivery target
    }])
    .select("id")
    .single()

  if (error || !request) {
    console.error("[RC-CHECK] Failed to create pending request:", error)
    return end("Error creating request.\nPlease try again.")
  }

  const email = await resolveEmail(momoPhone)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      await chargeMobileMoney({
        email,
        amount,
        phone: momoPhone,
        provider,
        reference: request.id,
        metadata: {
          source: "whatsapp_results_check",
          results_check_request_id: request.id,
          exam_board: session.rcCheckBoard,
          index_number: session.rcCheckIndex,
          exam_year: session.rcCheckYear,
          mode,
        },
      })
    } catch (err) {
      console.error("[RC-CHECK] MoMo charge failed:", err)
      await supabase.from("results_check_requests")
        .update({ payment_status: "failed", status: "failed", updated_at: new Date().toISOString() })
        .eq("id", request.id)
    }
  })

  await setSession(sessionId, { step: "MAIN", dialingPhone: waPhone })
  return end(
    `MoMo prompt sent to ${toLocal(momoPhone)}.\nApprove GHS ${amount.toFixed(2)} to submit\nyour results check request.\n\nReceived an OTP instead?\nRedial and enter the code.`
  )
}
