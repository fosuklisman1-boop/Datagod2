import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { parseVoucherCSV, uploadVoucherBatch } from "@/lib/results-checker-inventory-service"

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

    const text = await fileToCSVText(file)
    const { valid, errors } = parseVoucherCSV(text)

    if (valid.length === 0) {
      return NextResponse.json({
        error: "No valid rows found in CSV",
        parseErrors: errors,
      }, { status: 400 })
    }

    const { batchId, inserted, skipped } = await uploadVoucherBatch(valid, userId!)

    console.log(`[RC-UPLOAD] Admin ${userId} uploaded batch ${batchId}: ${inserted} inserted, ${skipped} skipped`)

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
