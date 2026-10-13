import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { listMessages, parsePage } from "@/lib/sms/admin-lists"

// GET ?q=&status=&page=
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  const sp = request.nextUrl.searchParams
  try {
    const data = await listMessages({ q: sp.get("q") ?? "", status: sp.get("status") ?? "", page: parsePage(sp.get("page")) })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    console.error("[SMS-ADMIN] messages failed:", e)
    return NextResponse.json({ success: false, error: "Could not load messages" }, { status: 500 })
  }
}
