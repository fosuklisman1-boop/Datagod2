import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const EXAM_BOARDS = ["WAEC", "BECE", "NOVDEC"] as const
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
}): Promise<RCPriceResult> {
  const { examBoard, quantity, shopId } = params
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

  const unitPrice = parseFloat((basePrice + markupPerVoucher).toFixed(2))
  const totalPaid = parseFloat((unitPrice * quantity).toFixed(2))
  const merchantCommission = parseFloat((markupPerVoucher * quantity).toFixed(2))

  return { basePrice, markupPerVoucher, unitPrice, totalPaid, merchantCommission }
}

export async function purchaseResultsCheckerVouchers(params: {
  userId: string
  examBoard: ExamBoard
  quantity: number
  shopId?: string
}): Promise<RCPurchaseResult> {
  const { userId, examBoard, quantity, shopId } = params
  const pricing = await calculateRCPrice({ examBoard, quantity, shopId })
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
