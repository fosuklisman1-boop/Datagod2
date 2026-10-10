import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listKycForAdmin } from "@/lib/sms/kyc-service"

// GET ?status=submitted|approved|rejected|draft|all (default submitted)
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  if (!auth.userId) return NextResponse.json({ success: false, error: "Admin user required" }, { status: 403 })
  const s = request.nextUrl.searchParams.get("status") ?? "submitted"
  if (!["submitted", "approved", "rejected", "draft", "all"].includes(s)) {
    return NextResponse.json({ success: false, error: "invalid status" }, { status: 400 })
  }
  return NextResponse.json({ success: true, data: await listKycForAdmin(s as "submitted") })
}
