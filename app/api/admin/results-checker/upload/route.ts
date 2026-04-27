import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { parseVoucherCSV, uploadVoucherBatch } from "@/lib/results-checker-inventory-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function fulfillPendingOrders(board: string) {
  const { data: pendingOrders } = await supabase
    .from("results_checker_orders")
    .select("*")
    .eq("exam_board", board)
    .eq("status", "pending")
    .eq("payment_status", "completed")
    .order("created_at", { ascending: true }) // FIFO

  if (!pendingOrders?.length) return

  console.log(`[RC-UPLOAD] ${pendingOrders.length} pending ${board} order(s) found — attempting auto-fulfillment`)

  for (const order of pendingOrders) {
    const { data: vouchers, error: assignError } = await supabase.rpc(
      "assign_results_checker_vouchers",
      { p_exam_board: order.exam_board, p_quantity: order.quantity, p_order_id: order.id }
    )

    if (assignError || !vouchers?.length || vouchers.length < order.quantity) {
      console.log(`[RC-UPLOAD] Not enough stock to fulfill order ${order.reference_code} — stopping`)
      break // No point trying later orders if stock is exhausted
    }

    await supabase.rpc("finalize_results_checker_sale", { p_order_id: order.id, p_user_id: null })

    const inventoryIds = vouchers.map((v: { id: string }) => v.id)
    await supabase
      .from("results_checker_orders")
      .update({ status: "completed", inventory_ids: inventoryIds, updated_at: new Date().toISOString() })
      .eq("id", order.id)

    if (order.merchant_commission > 0 && order.shop_id) {
      await supabase.from("shop_profits").insert([{
        shop_id: order.shop_id,
        results_checker_order_id: order.id,
        profit_amount: order.merchant_commission,
        status: "credited",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]).then(({ error }) => {
        if (error && error.code !== "23505") console.warn("[RC-UPLOAD] Profit insert error:", error.message)
      })
    }

    import("@/lib/results-checker-notification-service")
      .then(({ deliverVouchers }) => deliverVouchers(order, vouchers))
      .catch(e => console.warn("[RC-UPLOAD] Delivery error:", e))

    console.log(`[RC-UPLOAD] ✓ Auto-fulfilled order ${order.reference_code}`)
  }
}

async function fileToCSVText(file: File): Promise<string> {
  const isXlsx = file.name.endsWith(".xlsx") || file.name.endsWith(".xls")
  if (!isXlsx) return file.text()

  const { read, utils } = await import("xlsx")
  const buf = await file.arrayBuffer()
  const wb = read(buf, { type: "array" })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows: any[][] = utils.sheet_to_json(ws, { header: 1, defval: "" })
  return rows.map(r => r.map((c: any) => String(c ?? "")).join(",")).join("\n")
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }
    const isSupported = file.name.endsWith(".csv") || file.name.endsWith(".xlsx") || file.name.endsWith(".xls")
    if (!isSupported) {
      return NextResponse.json({ error: "File must be .csv or .xlsx" }, { status: 400 })
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (max 5MB)" }, { status: 400 })
    }

    const board = (formData.get("board") as string | null)?.trim().toUpperCase()
    if (!board || !["WAEC", "BECE", "NOVDEC"].includes(board)) {
      return NextResponse.json({ error: "Valid board is required (WAEC, BECE, or NOVDEC)" }, { status: 400 })
    }

    const rawText = await fileToCSVText(file)
    const lines = rawText.split("\n").map(l => l.trim()).filter(Boolean)
    const hasHeader = lines[0]?.toLowerCase().startsWith("pin") || lines[0]?.toLowerCase().startsWith("exam_board")
    const dataLines = hasHeader ? lines.slice(1) : lines
    const text = dataLines.map(l => `${board},${l}`).join("\n")

    const { valid, errors } = parseVoucherCSV(text)

    if (valid.length === 0) {
      return NextResponse.json({
        error: "No valid rows found in CSV",
        parseErrors: errors,
      }, { status: 400 })
    }

    const { batchId, inserted, skipped } = await uploadVoucherBatch(valid, userId!)

    console.log(`[RC-UPLOAD] Admin ${userId} uploaded batch ${batchId}: ${inserted} inserted, ${skipped} skipped`)

    // Non-blocking: fulfill any orders that were waiting for this board's stock
    if (inserted > 0) {
      fulfillPendingOrders(board).catch(e => console.warn("[RC-UPLOAD] Auto-fulfillment error:", e))
    }

    return NextResponse.json({
      success: true,
      batchId,
      inserted,
      skipped,
      parseErrors: errors,
      message: `${inserted} vouchers uploaded successfully${skipped > 0 ? `, ${skipped} duplicates skipped` : ""}`,
    })

  } catch (error) {
    console.error("[RC-UPLOAD] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
