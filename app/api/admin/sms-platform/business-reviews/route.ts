import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { listBusinessReviews } from "@/lib/sms/admin-reviews"

// GET ?status=submitted|approved|rejected|draft|all (default submitted) — rows include { account: { user_id, email, mode } }
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  try {
    return NextResponse.json({ success: true, data: await listBusinessReviews(request.nextUrl.searchParams.get("status") ?? "submitted") })
  } catch (e) {
    console.error("[SMS-ADMIN] business reviews failed:", e)
    return NextResponse.json({ success: false, error: "Could not load applications" }, { status: 500 })
  }
}
