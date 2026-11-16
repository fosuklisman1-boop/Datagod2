import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { supabaseAdmin } from "@/lib/supabase"
import { loadScopedRows, USER_EXPORT_LIMIT, type Section } from "@/lib/blocked-numbers/user-view"
import { authUserId, ownedShopIds } from "@/lib/blocked-numbers/user-auth"

export const dynamic = "force-dynamic"

const STATUS_LABEL = { waiting: "Waiting for activation", ready: "Ready", expired: "Expired" } as const

export async function GET(request: NextRequest) {
  const userId = await authUserId(request)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const sp = new URL(request.url).searchParams
    const section: Section = sp.get("section") === "orders" ? "orders" : "shops"
    const shopIds = await ownedShopIds(userId)
    const rows = (
      await loadScopedRows(
        supabaseAdmin,
        userId,
        section,
        { status: sp.get("status"), from: sp.get("from"), to: sp.get("to") },
        shopIds
      )
    ).slice(0, USER_EXPORT_LIMIT)

    const data = rows.map((r) => ({
      Phone: r.phone,
      "First tried": r.firstTried,
      "Last tried": r.lastTried,
      Attempts: r.attempts,
      Product: r.products.join(", "),
      Status: STATUS_LABEL[r.status],
    }))
    const ws = XLSX.utils.json_to_sheet(data, {
      header: ["Phone", "First tried", "Last tried", "Attempts", "Product", "Status"],
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, "Blocked numbers")
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" })
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="blocked-numbers-${section}-${new Date().toISOString().split("T")[0]}.xlsx"`,
        "Cache-Control": "no-store",
      },
    })
  } catch {
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
}
