import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const EXAM_BOARDS = ["WASSCE", "BECE", "NOVDEC"] as const
export type ExamBoard = typeof EXAM_BOARDS[number]

export interface VoucherPin {
  id: string
  pin: string
  serial_number: string | null
}

export interface RCPriceResult {
  basePrice: number
  markupPerVoucher: number
  unitPrice: number
  totalPaid: number
  merchantCommission: number
  bulkApplied: boolean
  bulkMinQty?: number
}

export interface RCPurchaseResult {
  order: Record<string, any>
  vouchers: VoucherPin[]
  newBalance: number
}

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", key)
    .single()
  return data?.value ?? null
}

// Append the voucher serial/PIN used for this check, if any, so the customer
// has a record of it (especially important for "combo" mode, where Datagod
// purchased the voucher on their behalf).
export function voucherInfoBlock(req: { voucher_pin?: string | null; voucher_serial?: string | null }): string {
  const lines: string[] = []
  if (req.voucher_serial) lines.push(`Serial: ${req.voucher_serial}`)
  if (req.voucher_pin) lines.push(`PIN: ${req.voucher_pin}`)
  return lines.length ? `\n\n${lines.join("\n")}` : ""
}

// admin_settings.results_check_admin_phones.phones — Ghana numbers (0XXXXXXXXX)
// of admins notified on WhatsApp for new Results Check requests, and who can
// claim/deliver requests via the WhatsApp admin flow.
export async function getResultsCheckAdminPhones(): Promise<string[]> {
  const value = await getAdminSetting("results_check_admin_phones")
  const phones = Array.isArray(value?.phones) ? value.phones : []
  return phones.filter((p: unknown): p is string => typeof p === "string" && p.length > 0)
}

// Notifies all configured admin WhatsApp numbers that a new results-check
// request is ready for processing. Re-fetches the row by id (rather than
// taking it as a param) so it always reflects any combo-voucher assignment
// the caller just performed.
export async function notifyAdminsNewResultsCheckRequest(requestId: string): Promise<void> {
  const phones = await getResultsCheckAdminPhones()
  if (phones.length === 0) return

  const { data: req } = await supabase
    .from("results_check_requests")
    .select("*")
    .eq("id", requestId)
    .single()
  if (!req) return

  const channelLabel = req.channel === "whatsapp" ? "WhatsApp" : req.channel === "web" ? "Web" : "USSD"
  const modeLabel = req.mode === "combo" ? "Combo (voucher assigned)" : "Own voucher"
  const message =
    `🔔 New Results Check Request\n\n` +
    `${req.exam_board} · ${modeLabel}\n` +
    `Index: ${req.index_number} (${req.exam_year})\n` +
    `Channel: ${channelLabel} · ${req.phone_number}\n` +
    `Ref: ${req.payment_reference}` +
    voucherInfoBlock(req) +
    `\n\nReply "pending" to view and pick up requests.`

  const { sendWhatsAppText } = await import("@/lib/whatsapp-bot/send")
  for (const phone of phones) {
    const waPhone = phone.startsWith("0") ? `233${phone.slice(1)}` : phone.replace(/^\+/, "")
    await sendWhatsAppText(waPhone, message).catch(e =>
      console.warn(`[RC-CHECK] Admin notify to ${phone} failed:`, e)
    )
  }
}

// Sends the result text and/or media stored on a results_check_requests row to
// the customer (and WhatsApp number, for USSD/web requests that provided one),
// then marks the request completed and releases any WhatsApp-admin claim.
// Shared by the web admin dashboard (app/api/admin/results-check-requests) and
// the WhatsApp admin flow (lib/whatsapp-bot/admin-router.ts).
export async function deliverResultsCheckRequest(
  requestId: string
): Promise<{ success: boolean; deliveryNotes: string[] }> {
  const { data: req, error } = await supabase
    .from("results_check_requests")
    .select("*")
    .eq("id", requestId)
    .single()

  if (error || !req) {
    return { success: false, deliveryNotes: [`Request not found: ${error?.message ?? requestId}`] }
  }

  if (!req.result_data && !req.media_url) {
    return { success: false, deliveryNotes: ["Nothing to deliver — no result text or media"] }
  }

  const deliveryNotes: string[] = []
  const mediaUrl: string | null = req.media_url ?? null
  const mediaType: string = req.media_type ?? "image"

  const { sendWhatsAppText, sendWhatsAppMedia } = await import("@/lib/whatsapp-bot/send")
  const { sendSMS } = await import("@/lib/sms-service")

  deliveryNotes.push(
    `delivery start: channel=${req.channel}, hasResultText=${!!req.result_data}, mediaUrl=${mediaUrl ?? "none"}, mediaType=${mediaType}, whatsapp_number=${req.whatsapp_number ?? "none"}`
  )

  if (req.channel === "whatsapp") {
    const phone = req.phone_number.startsWith("0")
      ? `233${req.phone_number.slice(1)}`
      : req.phone_number.replace(/^\+/, "")

    if (req.result_data) {
      const resultMsg =
        `Your ${req.exam_board} results for index number ${req.index_number} (${req.exam_year}):\n\n` +
        req.result_data +
        voucherInfoBlock(req) +
        `\n\nRef: ${req.payment_reference}`
      await sendWhatsAppText(phone, resultMsg)
        .then(() => deliveryNotes.push(`WhatsApp text sent to ${phone}`))
        .catch(e => {
          const msg = `WhatsApp text FAILED: ${e instanceof Error ? e.message : String(e)}`
          console.error("[RC-DELIVER]", msg)
          deliveryNotes.push(msg)
        })
    }

    if (mediaUrl) {
      const caption = req.result_data
        ? undefined
        : `Your ${req.exam_board} results — ${req.index_number} (${req.exam_year})${voucherInfoBlock(req)}`
      await sendWhatsAppMedia(
        phone,
        mediaType as "image" | "document" | "video",
        mediaUrl,
        caption,
        mediaType === "document" ? `${req.exam_board}_results_${req.exam_year}.pdf` : undefined,
      )
        .then(() => deliveryNotes.push(`WhatsApp media sent to ${phone}`))
        .catch(e => {
          const msg = `WhatsApp media FAILED: ${e instanceof Error ? e.message : String(e)}`
          console.error("[RC-DELIVER]", msg)
          deliveryNotes.push(msg)
        })
    }
  } else {
    if (req.result_data) {
      const resultMsg =
        `${req.exam_board} results for ${req.index_number} (${req.exam_year}):\n` +
        req.result_data +
        voucherInfoBlock(req) +
        `\nRef: ${req.payment_reference}`
      await sendSMS({ phone: req.phone_number, message: resultMsg, type: "results_check", reference: req.id })
        .then(() => deliveryNotes.push(`SMS sent to ${req.phone_number}`))
        .catch(e => {
          const msg = `SMS FAILED: ${e instanceof Error ? e.message : String(e)}`
          console.error("[RC-DELIVER]", msg)
          deliveryNotes.push(msg)
        })
    }

    if (req.whatsapp_number) {
      const waPhone = req.whatsapp_number.startsWith("0")
        ? `233${req.whatsapp_number.slice(1)}`
        : req.whatsapp_number.replace(/^\+/, "")

      if (req.result_data) {
        const waMsg =
          `Your ${req.exam_board} results for index ${req.index_number} (${req.exam_year}):\n\n` +
          req.result_data +
          voucherInfoBlock(req) +
          `\n\nRef: ${req.payment_reference}`
        await sendWhatsAppText(waPhone, waMsg)
          .then(() => deliveryNotes.push(`WhatsApp text sent to ${waPhone}`))
          .catch(e => {
            const msg = `WhatsApp text to USSD user FAILED: ${e instanceof Error ? e.message : String(e)}`
            console.error("[RC-DELIVER]", msg)
            deliveryNotes.push(msg)
          })
      }
      if (mediaUrl) {
        const caption = req.result_data
          ? undefined
          : `Your ${req.exam_board} results — ${req.index_number} (${req.exam_year})${voucherInfoBlock(req)}`
        await sendWhatsAppMedia(
          waPhone,
          mediaType as "image" | "document" | "video",
          mediaUrl,
          caption,
          mediaType === "document" ? `${req.exam_board}_results_${req.exam_year}.pdf` : undefined,
        )
          .then(() => deliveryNotes.push(`WhatsApp media sent to ${waPhone}`))
          .catch(e => {
            const msg = `WhatsApp media to USSD user FAILED: ${e instanceof Error ? e.message : String(e)}`
            console.error("[RC-DELIVER]", msg)
            deliveryNotes.push(msg)
          })
      }
    } else if (!req.result_data) {
      deliveryNotes.push("No SMS sent (no result text) and no whatsapp_number on file for media delivery")
    }
  }

  deliveryNotes.forEach(n => console.log("[RC-DELIVER]", n))

  await supabase
    .from("results_check_requests")
    .update({ status: "completed", claimed_by: null, claimed_at: null, updated_at: new Date().toISOString() })
    .eq("id", req.id)

  return { success: true, deliveryNotes }
}

function generateRCReference(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const seg = (n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  return `RC-${seg(3)}-${seg(3)}`
}

export function isValidExamBoard(board: string): board is ExamBoard {
  return EXAM_BOARDS.includes(board as ExamBoard)
}

export async function isExamBoardEnabled(examBoard: ExamBoard): Promise<boolean> {
  const setting = await getAdminSetting(`results_checker_enabled_${examBoard.toLowerCase()}`)
  return setting?.enabled !== false
}

export async function getMaxQuantity(): Promise<number> {
  const setting = await getAdminSetting("results_checker_max_quantity")
  return setting?.max ?? 50
}

export async function getAvailableCount(examBoard: ExamBoard): Promise<number> {
  const { count } = await supabase
    .from("results_checker_inventory")
    .select("*", { count: "exact", head: true })
    .eq("exam_board", examBoard)
    .eq("status", "available")
  return count ?? 0
}

export async function calculateRCPrice(params: {
  examBoard: ExamBoard
  quantity: number
  shopId?: string
  applyBulk?: boolean
}): Promise<RCPriceResult> {
  const { examBoard, quantity, shopId, applyBulk = false } = params
  const boardKey = examBoard.toLowerCase()

  const baseSetting = await getAdminSetting(`results_checker_price_${boardKey}`)
  const basePrice = parseFloat(baseSetting?.price ?? 0)

  let markupPerVoucher = 0

  if (shopId) {
    const { data: shop } = await supabase
      .from("user_shops")
      .select(`results_checker_markup_${boardKey}`)
      .eq("id", shopId)
      .single()

    if (shop) {
      const rawMarkup = parseFloat((shop as any)[`results_checker_markup_${boardKey}`] ?? 0)
      const maxMarkupSetting = await getAdminSetting(`results_checker_max_markup_${boardKey}`)
      const maxMarkup = parseFloat(maxMarkupSetting?.max ?? 0)
      markupPerVoucher = Math.min(rawMarkup, maxMarkup)
    }
  }

  // Bulk pricing — applies when explicitly requested and quantity meets the threshold.
  // For shop orders the shop markup is preserved on top of the reduced bulk base price.
  // A bulk price of 0 means disabled for that board.
  let bulkApplied = false
  let bulkMinQty: number | undefined

  if (applyBulk) {
    const [bulkMinSetting, bulkPriceSetting] = await Promise.all([
      getAdminSetting("results_checker_bulk_min_quantity"),
      getAdminSetting(`results_checker_bulk_price_${boardKey}`),
    ])
    const minQty = bulkMinSetting?.min ?? 0
    const bulkPrice = parseFloat(bulkPriceSetting?.price ?? 0)

    if (minQty > 0 && bulkPrice > 0 && quantity >= minQty && bulkPrice < basePrice) {
      if (shopId) {
        // Shop orders: bulk reduces the base price; shop markup still applies so the
        // merchant earns their commission and the customer gets a lower effective rate.
        const unitPrice = parseFloat((bulkPrice + markupPerVoucher).toFixed(2))
        const totalPaid = parseFloat((unitPrice * quantity).toFixed(2))
        const merchantCommission = parseFloat((markupPerVoucher * quantity).toFixed(2))
        return { basePrice: bulkPrice, markupPerVoucher, unitPrice, totalPaid, merchantCommission, bulkApplied: true, bulkMinQty: minQty }
      } else {
        // Direct purchases: bulk price is the full unit price (no separate markup).
        const unitPrice = parseFloat(bulkPrice.toFixed(2))
        const totalPaid = parseFloat((unitPrice * quantity).toFixed(2))
        return { basePrice, markupPerVoucher: 0, unitPrice, totalPaid, merchantCommission: 0, bulkApplied: true, bulkMinQty: minQty }
      }
    }

    bulkMinQty = minQty > 0 ? minQty : undefined
  }

  const unitPrice = parseFloat((basePrice + markupPerVoucher).toFixed(2))
  const totalPaid = parseFloat((unitPrice * quantity).toFixed(2))
  const merchantCommission = parseFloat((markupPerVoucher * quantity).toFixed(2))

  return { basePrice, markupPerVoucher, unitPrice, totalPaid, merchantCommission, bulkApplied, bulkMinQty }
}

export interface ResultsCheckPriceResult {
  checkFee: number
  checkFeeMarkup: number
  effectiveCheckFee: number
  voucherPrice?: number       // combo only
  totalPaid: number
  merchantCommission: number  // checkFeeMarkup (+ voucher commission if combo)
}

/**
 * Pricing for the Results Check Service (Datagod checks results on the
 * customer's behalf — distinct from the voucher-purchase flow above).
 * own_voucher mode charges only the check fee (+ shop markup); combo mode
 * also bundles a voucher purchase via calculateRCPrice.
 */
export async function calculateResultsCheckPrice(params: {
  examBoard: ExamBoard
  mode: "combo" | "own_voucher"
  shopId?: string
}): Promise<ResultsCheckPriceResult> {
  const { examBoard, mode, shopId } = params

  const settings = await getAdminSetting("results_check_settings")
  const checkFee = parseFloat(settings?.fee ?? 0)

  let checkFeeMarkup = 0
  if (shopId) {
    const { data: shop } = await supabase
      .from("user_shops")
      .select("results_check_markup")
      .eq("id", shopId)
      .single()

    if (shop) {
      const rawMarkup = parseFloat((shop as any).results_check_markup ?? 0)
      const maxMarkupSetting = await getAdminSetting("results_check_max_markup")
      const maxMarkup = parseFloat(maxMarkupSetting?.max ?? 0)
      checkFeeMarkup = Math.min(rawMarkup, maxMarkup)
    }
  }

  const effectiveCheckFee = parseFloat((checkFee + checkFeeMarkup).toFixed(2))

  if (mode === "combo") {
    const voucherPricing = await calculateRCPrice({ examBoard, quantity: 1, shopId, applyBulk: false })
    const totalPaid = parseFloat((voucherPricing.unitPrice + effectiveCheckFee).toFixed(2))
    const merchantCommission = parseFloat((voucherPricing.merchantCommission + checkFeeMarkup).toFixed(2))
    return {
      checkFee,
      checkFeeMarkup,
      effectiveCheckFee,
      voucherPrice: voucherPricing.unitPrice,
      totalPaid,
      merchantCommission,
    }
  }

  return {
    checkFee,
    checkFeeMarkup,
    effectiveCheckFee,
    totalPaid: effectiveCheckFee,
    merchantCommission: checkFeeMarkup,
  }
}

export async function purchaseResultsCheckerVouchers(params: {
  userId: string
  examBoard: ExamBoard
  quantity: number
  shopId?: string
  applyBulk?: boolean
}): Promise<RCPurchaseResult> {
  const { userId, examBoard, quantity, shopId, applyBulk = false } = params
  const pricing = await calculateRCPrice({ examBoard, quantity, shopId, applyBulk })
  const referenceCode = generateRCReference()

  // Atomic wallet deduction
  const { data: deductResult, error: deductError } = await supabase.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: pricing.totalPaid,
  })

  if (deductError) throw new Error("Failed to process payment")
  if (!deductResult || deductResult.length === 0) {
    const err: any = new Error("Insufficient wallet balance")
    err.code = "INSUFFICIENT_BALANCE"
    err.required = pricing.totalPaid
    throw err
  }

  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

  // Create order record
  const { data: order, error: orderError } = await supabase
    .from("results_checker_orders")
    .insert([{
      user_id: userId,
      reference_code: referenceCode,
      exam_board: examBoard,
      quantity,
      unit_price: pricing.unitPrice,
      fee_amount: 0,
      total_paid: pricing.totalPaid,
      shop_id: shopId ?? null,
      merchant_commission: pricing.merchantCommission,
      status: "pending",
      payment_status: "completed",
    }])
    .select()
    .single()

  if (orderError || !order) {
    // Refund wallet on order creation failure
    await supabase.from("wallets").update({
      balance: balanceBefore,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId)
    throw new Error("Failed to create order. Wallet refunded.")
  }

  // Assign vouchers atomically
  const { data: vouchers, error: assignError } = await supabase.rpc(
    "assign_results_checker_vouchers",
    { p_exam_board: examBoard, p_quantity: quantity, p_order_id: order.id }
  )

  if (assignError) {
    console.error("[RC-SERVICE] ❌ assign_results_checker_vouchers RPC error:", assignError)
  } else if (!vouchers || vouchers.length < quantity) {
    console.warn(`[RC-SERVICE] ⚠ assign_results_checker_vouchers returned ${vouchers?.length ?? 0}/${quantity} for ${examBoard} order ${order.id}`)
  }

  if (assignError || !vouchers || vouchers.length < quantity) {
    // Refund and fail order if inventory insufficient after deduction
    await supabase.rpc("credit_wallet_safely", {
      p_user_id: userId,
      p_amount: pricing.totalPaid,
      p_reference_id: `refund-${referenceCode}`,
      p_description: "Results checker order refund — insufficient inventory",
      p_source: "results_checker_refund",
    })
    await supabase
      .from("results_checker_orders")
      .update({ status: "failed", payment_status: "failed", updated_at: new Date().toISOString() })
      .eq("id", order.id)
    const err: any = new Error("Insufficient voucher inventory")
    err.code = "INSUFFICIENT_INVENTORY"
    throw err
  }

  // Finalize sale
  await supabase.rpc("finalize_results_checker_sale", {
    p_order_id: order.id,
    p_user_id: userId,
  })

  const inventoryIds = vouchers.map((v: VoucherPin) => v.id)

  // Update order to completed
  await supabase
    .from("results_checker_orders")
    .update({
      status: "completed",
      inventory_ids: inventoryIds,
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id)

  // Shop profit record
  if (pricing.merchantCommission > 0 && shopId) {
    await supabase.from("shop_profits").insert([{
      shop_id: shopId,
      results_checker_order_id: order.id,
      profit_amount: pricing.merchantCommission,
      status: "credited",
      adjustment_type: "results_checker",
      created_at: new Date().toISOString(),
    }]).then(({ error }) => {
      if (error && error.code !== "23505") {
        console.error("[RC] Failed to insert shop profit:", error)
      }
    })
  }

  // Transaction ledger
  await supabase.from("transactions").insert([{
    user_id: userId,
    type: "debit",
    source: "results_checker_purchase",
    amount: pricing.totalPaid,
    balance_before: balanceBefore,
    balance_after: newBalance,
    description: `${examBoard} Results Checker x${quantity} — Ref: ${referenceCode}`,
    reference_id: order.id,
    status: "completed",
    created_at: new Date().toISOString(),
  }])

  // In-app notification
  await supabase.from("notifications").insert([{
    user_id: userId,
    title: `${examBoard} Voucher${quantity > 1 ? "s" : ""} Delivered`,
    message: `Your ${quantity} ${examBoard} voucher${quantity > 1 ? "s" : ""} are ready. Ref: ${referenceCode}`,
    type: "voucher_delivered",
    reference_id: order.id,
    action_url: `/dashboard/results-checker`,
    read: false,
  }])

  return { order: { ...order, status: "completed", inventory_ids: inventoryIds }, vouchers, newBalance }
}

/** Returns bulk threshold and base bulk price for a board, or null if not configured / not cheaper. */
export async function getRCBulkHint(examBoard: ExamBoard): Promise<{ minQty: number; bulkBasePrice: number } | null> {
  const boardKey = examBoard.toLowerCase()
  const [minSetting, bulkPriceSetting, baseSetting] = await Promise.all([
    getAdminSetting("results_checker_bulk_min_quantity"),
    getAdminSetting(`results_checker_bulk_price_${boardKey}`),
    getAdminSetting(`results_checker_price_${boardKey}`),
  ])
  const minQty = minSetting?.min ?? 0
  const bulkBasePrice = parseFloat(bulkPriceSetting?.price ?? 0)
  const basePrice = parseFloat(baseSetting?.price ?? 0)
  if (minQty > 0 && bulkBasePrice > 0 && bulkBasePrice < basePrice) {
    return { minQty, bulkBasePrice }
  }
  return null
}

export async function refundRCOrder(orderId: string, userId: string, amount: number): Promise<void> {
  const { data: order } = await supabase
    .from("results_checker_orders")
    .select("reference_code")
    .eq("id", orderId)
    .single()

  await supabase.rpc("credit_wallet_safely", {
    p_user_id: userId,
    p_amount: amount,
    p_reference_id: `refund-${order?.reference_code ?? orderId}`,
    p_description: "Results checker order refund",
    p_source: "results_checker_refund",
  })

  // Release any reserved inventory back to available
  await supabase
    .from("results_checker_inventory")
    .update({ status: "available", reserved_by_order: null, reservation_expires_at: null, updated_at: new Date().toISOString() })
    .eq("reserved_by_order", orderId)
    .eq("status", "reserved")

  await supabase
    .from("results_checker_orders")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
}

/**
 * Fulfils a results-checker order whose payment has just been confirmed:
 * atomically assigns vouchers → finalizes the sale → records merchant profit →
 * delivers the PINs (SMS/email). Used by the storefront webhook branch (guest
 * MoMo via wallet_payments) and the USSD direct-charge webhook branch.
 *
 * Wallet purchases do NOT use this — they go through purchaseResultsCheckerVouchers
 * which deducts and assigns synchronously.
 *
 * If stock was exhausted between order creation and payment, the order is left
 * paid-but-undelivered (status 'pending') for an admin to resolve/refund — same
 * fallback the storefront has always used.
 */
export async function fulfillPaidResultsCheckerOrder(
  orderId: string
): Promise<{ success: boolean; status: "completed" | "pending" | "failed" | "not_found"; message: string }> {
  const { data: rcOrder } = await supabase
    .from("results_checker_orders")
    .select("*")
    .eq("id", orderId)
    .single()

  if (!rcOrder) return { success: false, status: "not_found", message: "RC order not found" }
  if (rcOrder.status === "completed") return { success: true, status: "completed", message: "Already completed" }
  if (rcOrder.status === "failed") return { success: false, status: "failed", message: "Order already failed" }

  // Atomically reserve vouchers (all-or-nothing under concurrency)
  const { data: vouchers, error: assignError } = await supabase.rpc(
    "assign_results_checker_vouchers",
    { p_exam_board: rcOrder.exam_board, p_quantity: rcOrder.quantity, p_order_id: rcOrder.id }
  )

  if (assignError || !vouchers || vouchers.length < rcOrder.quantity) {
    console.warn(`[RC-SERVICE] ⚠ RC voucher stock exhausted for order ${rcOrder.id} — marking pending`)
    await supabase
      .from("results_checker_orders")
      .update({ status: "pending", payment_status: "completed", updated_at: new Date().toISOString() })
      .eq("id", rcOrder.id)
    return { success: false, status: "pending", message: "Stock exhausted — paid, awaiting manual delivery" }
  }

  await supabase.rpc("finalize_results_checker_sale", { p_order_id: rcOrder.id, p_user_id: rcOrder.user_id ?? null })

  const inventoryIds = vouchers.map((v: VoucherPin) => v.id)
  const { error: rcUpdateErr } = await supabase
    .from("results_checker_orders")
    .update({
      status: "completed",
      payment_status: "completed",
      inventory_ids: inventoryIds,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rcOrder.id)
  if (rcUpdateErr) console.error("[RC-SERVICE] ❌ Failed to mark RC order completed:", rcUpdateErr)

  if (rcOrder.merchant_commission > 0 && rcOrder.shop_id) {
    const { error: rcProfitError } = await supabase.from("shop_profits").insert([{
      shop_id: rcOrder.shop_id,
      results_checker_order_id: rcOrder.id,
      profit_amount: rcOrder.merchant_commission,
      status: "credited",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }])
    if (rcProfitError && rcProfitError.code !== "23505") {
      // Fallback: insert without FK column if migration 0045 not yet applied
      await supabase.from("shop_profits").insert([{
        shop_id: rcOrder.shop_id,
        profit_amount: rcOrder.merchant_commission,
        status: "credited",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]).then(({ error: e }) => {
        if (e && e.code !== "23505") console.error("[RC-SERVICE] ❌ RC profit fallback failed:", e.message)
      })
    } else if (!rcProfitError) {
      console.log(`[RC-SERVICE] ✓ RC profit recorded: GHS ${rcOrder.merchant_commission}`)
    }
  }

  // Deliver PINs (SMS + email). Dynamic import avoids a service↔notification cycle.
  const { deliverVouchers } = await import("@/lib/results-checker-notification-service")
  await deliverVouchers(rcOrder, vouchers).catch(e => console.warn("[RC-SERVICE] RC delivery error:", e))

  console.log(`[RC-SERVICE] ✓ RC order ${rcOrder.reference_code} completed: ${rcOrder.quantity}x ${rcOrder.exam_board}`)
  return { success: true, status: "completed", message: "Vouchers delivered" }
}

/**
 * Fulfils a storefront Results Check Service request (table
 * `results_check_requests`) whose payment has just been confirmed.
 * For combo mode, assigns one voucher from results_checker_inventory
 * (same two-step pattern as the WhatsApp webhook branch). Marks
 * payment_status 'paid' (status stays 'pending' — admin still needs to
 * perform the actual results check via app/admin/results-check-requests),
 * records merchant commission, and sends a payment-confirmation message
 * (not the results themselves).
 */
export async function fulfillPaidResultsCheckRequest(
  requestId: string
): Promise<{ success: boolean; status: "paid" | "already_paid" | "not_found"; message: string }> {
  const { data: req } = await supabase
    .from("results_check_requests")
    .select("*")
    .eq("id", requestId)
    .single()

  if (!req) return { success: false, status: "not_found", message: "Results check request not found" }
  if (req.payment_status === "paid") return { success: true, status: "already_paid", message: "Already paid" }

  let assignedVoucherPin: string | null = req.voucher_pin ?? null
  let assignedVoucherSerial: string | null = req.voucher_serial ?? null
  if (req.mode === "combo") {
    const { data: voucherRows } = await supabase
      .from("results_checker_inventory")
      .select("id, pin, serial_number")
      .eq("exam_board", req.exam_board)
      .eq("status", "available")
      .limit(1)
    if (voucherRows && voucherRows.length > 0) {
      const v = voucherRows[0]
      await supabase.from("results_checker_inventory")
        .update({ status: "sold", updated_at: new Date().toISOString() })
        .eq("id", v.id)
      assignedVoucherPin = v.pin
      assignedVoucherSerial = v.serial_number ?? null
    } else {
      console.warn(`[RC-CHECK] ⚠ No available ${req.exam_board} voucher for combo request ${req.id}`)
    }
  }

  const updatePayload: Record<string, unknown> = {
    payment_status: "paid",
    updated_at: new Date().toISOString(),
  }
  if (assignedVoucherPin) updatePayload.voucher_pin = assignedVoucherPin
  if (assignedVoucherSerial) updatePayload.voucher_serial = assignedVoucherSerial

  await supabase
    .from("results_check_requests")
    .update(updatePayload)
    .eq("id", req.id)

  await notifyAdminsNewResultsCheckRequest(req.id).catch(e => console.warn("[RC-CHECK] Admin notify failed:", e))

  if (req.shop_id && req.merchant_commission > 0) {
    const { error: profitError } = await supabase.from("shop_profits").insert([{
      shop_id: req.shop_id,
      results_check_request_id: req.id,
      profit_amount: req.merchant_commission,
      status: "credited",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }])
    if (profitError && profitError.code !== "23505") {
      // Fallback: insert without FK column if migration 20260610 not yet applied
      await supabase.from("shop_profits").insert([{
        shop_id: req.shop_id,
        profit_amount: req.merchant_commission,
        status: "credited",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]).then(({ error: e }) => {
        if (e && e.code !== "23505") console.error("[RC-CHECK] ❌ profit fallback failed:", e.message)
      })
    } else if (!profitError) {
      console.log(`[RC-CHECK] ✓ Shop profit recorded: GHS ${req.merchant_commission}`)
    }
  }

  // Payment-confirmation message — actual results follow later via the admin delivery queue.
  const voucherNote = req.mode === "combo"
    ? `\nSerial: ${assignedVoucherSerial ?? "N/A"}\nPIN: ${assignedVoucherPin ?? "will be assigned"}`
    : ""
  const confirmMsg =
    `Payment received! Your ${req.exam_board} results check request (Index: ${req.index_number}, ${req.exam_year}) is being processed.\n` +
    `Ref: ${req.payment_reference}${voucherNote}\n\n` +
    `We'll send your results via SMS${req.whatsapp_number ? " and WhatsApp" : ""} shortly.`

  const { sendSMS } = await import("@/lib/sms-service")
  await sendSMS({ phone: req.phone_number, message: confirmMsg, type: "results_check_payment", reference: req.id })
    .catch(e => console.warn("[RC-CHECK] SMS confirmation failed:", e))

  if (req.whatsapp_number) {
    const { sendWhatsAppText } = await import("@/lib/whatsapp-bot/send")
    const waPhone = req.whatsapp_number.startsWith("0")
      ? `233${req.whatsapp_number.slice(1)}`
      : req.whatsapp_number.replace(/^\+/, "")
    await sendWhatsAppText(waPhone, confirmMsg).catch(e => console.warn("[RC-CHECK] WhatsApp confirmation failed:", e))
  }

  console.log(`[RC-CHECK] ✓ Results check request ${req.payment_reference} marked paid (mode=${req.mode})`)
  return { success: true, status: "paid", message: "Payment confirmed" }
}

