import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  isValidExamBoard,
  isExamBoardEnabled,
  getMaxQuantity,
  calculateRCPrice,
} from "@/lib/results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function generateRCReference(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const seg = (n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  return `RC-${seg(3)}-${seg(3)}`
}

export async function POST(request: NextRequest) {
  try {
    const { shopId, examBoard, quantity: rawQuantity, customerName, customerEmail, customerPhone } =
      await request.json()

    if (!shopId || !examBoard || !rawQuantity || !customerEmail) {
      return NextResponse.json({ error: "shopId, examBoard, quantity, and customerEmail are required" }, { status: 400 })
    }
    if (!isValidExamBoard(examBoard)) {
      return NextResponse.json({ error: "Invalid examBoard. Must be WAEC, BECE, or NOVDEC" }, { status: 400 })
    }

    const quantity = parseInt(rawQuantity)
    if (isNaN(quantity) || quantity < 1) {
      return NextResponse.json({ error: "quantity must be a positive integer" }, { status: 400 })
    }

    const maxQty = await getMaxQuantity()
    if (quantity > maxQty) {
      return NextResponse.json({ error: `Maximum ${maxQty} vouchers per order` }, { status: 400 })
    }

    const enabled = await isExamBoardEnabled(examBoard)
    if (!enabled) {
      return NextResponse.json({ error: `${examBoard} vouchers are currently unavailable` }, { status: 503 })
    }

    // Verify shop exists
    const { data: shop } = await supabase
      .from("user_shops")
      .select("id, shop_name")
      .eq("id", shopId)
      .single()

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    const pricing = await calculateRCPrice({ examBoard, quantity, shopId })
    const referenceCode = generateRCReference()

    // Create pending order — do NOT reserve inventory yet (payment not confirmed)
    const { data: order, error: orderError } = await supabase
      .from("results_checker_orders")
      .insert([{
        reference_code: referenceCode,
        exam_board: examBoard,
        quantity,
        customer_name: customerName ?? "Guest",
        customer_email: customerEmail,
        customer_phone: customerPhone ?? null,
        unit_price: pricing.unitPrice,
        fee_amount: 0,
        total_paid: pricing.totalPaid,
        shop_id: shopId,
        merchant_commission: pricing.merchantCommission,
        status: "pending_payment",
        payment_status: "pending_payment",
      }])
      .select()
      .single()

    if (orderError || !order) {
      console.error("[RC-SHOP-INIT] Order creation error:", orderError)
      return NextResponse.json({ error: "Failed to initialize order" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      orderId: order.id,
      totalPrice: pricing.totalPaid,
      reference: referenceCode,
    })

  } catch (error) {
    console.error("[RC-SHOP-INIT] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
