import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDShopSession } from "../types"
import {
  cont, end, productMenu,
  shopRcBoardMenu, shopRcQtyPrompt, shopRcConfirmMenu,
} from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import { chargeMobileMoney } from "@/lib/paystack"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { secureReference } from "@/lib/secure-random"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import {
  isExamBoardEnabled, getAvailableCount, getMaxQuantity, calculateRCPrice,
  getRCBulkHint, type ExamBoard,
} from "@/lib/results-checker-service"
import { buildRcBoardOptions } from "@/lib/ussd/handlers/results-checker"
import { createShopRcOrder } from "@/lib/shop-commerce/orders"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function toLocal(phone: string): string {
  if (phone.startsWith("+233")) return "0" + phone.slice(4)
  if (phone.startsWith("233")) return "0" + phone.slice(3)
  return phone
}

// ── SHOP_RC_SELECT_BOARD ──────────────────────────────────────────────────────
export async function handleShopRcSelectBoard(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? "Shop"
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "SELECT_PRODUCT" })
    return cont(productMenu(shopName))
  }

  const options = session.rcBoardOptions ?? []
  const idx = parseInt(input.trim(), 10) - 1
  const board = options[idx]
  if (!board) return cont(shopRcBoardMenu(shopName, options))

  const [avail, max, bulkHint] = await Promise.all([getAvailableCount(board as ExamBoard), getMaxQuantity(), getRCBulkHint(board as ExamBoard)])
  let bulkForMenu: { minQty: number; unitPrice: number } | null = null
  if (bulkHint) {
    // Price at the bulk threshold including shop markup — this is what the customer pays.
    const bulkPricing = await calculateRCPrice({ examBoard: board as ExamBoard, quantity: bulkHint.minQty, shopId: session.shopId, applyBulk: true })
    if (bulkPricing.bulkApplied) bulkForMenu = { minQty: bulkHint.minQty, unitPrice: bulkPricing.unitPrice }
  }
  await setSession(sessionId, { ...session, step: "SHOP_RC_ENTER_QTY", rcBoard: board })
  return cont(shopRcQtyPrompt(board, avail, max, bulkForMenu))
}

// ── SHOP_RC_ENTER_QTY ─────────────────────────────────────────────────────────
export async function handleShopRcEnterQty(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? "Shop"
  if (input.trim() === "0") {
    const boards = await buildRcBoardOptions()
    await setSession(sessionId, { ...session, step: "SHOP_RC_SELECT_BOARD", rcBoardOptions: boards })
    return cont(shopRcBoardMenu(shopName, boards))
  }

  const board = session.rcBoard! as ExamBoard
  const [avail, max, bulkHint] = await Promise.all([getAvailableCount(board), getMaxQuantity(), getRCBulkHint(board)])
  let bulkForMenu: { minQty: number; unitPrice: number } | null = null
  if (bulkHint) {
    const bulkPricing = await calculateRCPrice({ examBoard: board, quantity: bulkHint.minQty, shopId: session.shopId, applyBulk: true })
    if (bulkPricing.bulkApplied) bulkForMenu = { minQty: bulkHint.minQty, unitPrice: bulkPricing.unitPrice }
  }
  const cap = Math.min(avail, max)
  const qty = parseInt(input.trim(), 10)
  if (isNaN(qty) || qty < 1 || qty > cap) {
    return cont(`Enter a valid quantity.\n` + shopRcQtyPrompt(board, avail, max, bulkForMenu))
  }

  // Include shop markup and bulk discount in the price shown to caller.
  const pricing = await calculateRCPrice({ examBoard: board, quantity: qty, shopId: session.shopId, applyBulk: true })

  await setSession(sessionId, {
    ...session,
    step: "SHOP_RC_CONFIRM",
    rcQty: qty,
    rcUnitPrice: pricing.unitPrice,
    rcTotal: pricing.totalPaid,
    rcMerchantCommission: pricing.merchantCommission,
  })
  return cont(shopRcConfirmMenu(shopName, board, qty, pricing.totalPaid, session.dialingPhone!))
}

// ── SHOP_RC_CONFIRM ───────────────────────────────────────────────────────────
export async function handleShopRcConfirm(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? "Shop"
  if (input.trim() === "2" || input.trim() === "0") return end("Order cancelled.")
  if (input.trim() !== "1") {
    return cont(shopRcConfirmMenu(shopName, session.rcBoard!, session.rcQty!, session.rcTotal!, session.dialingPhone!))
  }

  const board = session.rcBoard! as ExamBoard
  const qty = session.rcQty!
  const dialingPhone = session.dialingPhone!

  // Re-verify availability + price (stale-session guard)
  const [enabled, avail] = await Promise.all([isExamBoardEnabled(board), getAvailableCount(board)])
  if (!enabled || avail < qty) {
    return end(`${board} vouchers are no longer available in that quantity.`)
  }
  const pricing = await calculateRCPrice({ examBoard: board, quantity: qty, shopId: session.shopId, applyBulk: true })

  const provider = paystackProviderFromPhone(dialingPhone)
  if (!provider) return end("Payment not available for your number.")

  const localDialing = toLocal(dialingPhone)
  const referenceCode = secureReference("RC", 2, 3)

  const orderResult = await createShopRcOrder({
    referenceCode,
    examBoard: board,
    quantity: qty,
    customerPhone: localDialing,
    unitPrice: pricing.unitPrice,
    totalPaid: pricing.totalPaid,
    shopId: session.shopId!,
    merchantCommission: pricing.merchantCommission,
    dialingPhone,
    channel: "ussd_shop",
  })

  if ("error" in orderResult) {
    console.error("[USSD-SHOP-RC] Failed to create order:", orderResult.error)
    return end("Error creating order.\nPlease try again.")
  }
  const orderId = orderResult.orderId

  const email = await resolveEmail(dialingPhone)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await chargeMobileMoney({
        email,
        amount: pricing.totalPaid,
        phone: dialingPhone,
        provider,
        reference: orderId,
        metadata: {
          source: "ussd_shop_results_checker",
          results_checker_order_id: orderId,
          exam_board: board,
          quantity: qty,
          shop_id: session.shopId,
        },
      })
      try {
        await supabase.from("payment_attempts").insert({
          reference: orderId, amount: pricing.totalPaid, email,
          status: "pending", payment_type: "ussd_shop_results_checker", order_id: orderId,
        })
      } catch (paErr) {
        console.warn("[USSD-SHOP-RC] payment_attempts insert failed (non-fatal):", paErr)
      }
      console.log("[USSD-SHOP-RC] ✓ Charge initiated:", orderId, "status:", status)
      if (status === "send_otp") {
        await supabase.from("results_checker_orders")
          .update({ payment_status: "otp_required", updated_at: new Date().toISOString() })
          .eq("id", orderId)
        sendSMS({ phone: dialingPhone, message: SMSTemplates.ussdOtpRequired(), type: "otp_required", reference: orderId }).catch(() => {})
      }
    } catch (err) {
      console.error("[USSD-SHOP-RC] Charge failed:", err)
      await supabase.from("results_checker_orders")
        .update({ payment_status: "failed", status: "failed", updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  await setSession(sessionId, {
    ...session,
    pendingOrderId: orderId,
    pendingOrderTable: "results_checker_orders",
    step: "ENTER_SHOP_CODE",
  })
  return end(`MoMo prompt sent to ${localDialing}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`)
}
