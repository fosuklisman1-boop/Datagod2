import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { findStuckV2 } from "@/lib/api-v2/stuck"

export const dynamic = "force-dynamic"

/** GET /api/admin/api-v2/stuck - Admin: v2 claims and orders unfinished for over 10 minutes (read-only). */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (errorResponse) return errorResponse
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    return NextResponse.json(await findStuckV2(getAdminClient(), new Date()))
  } catch (e) {
    console.error("[ADMIN API V2] Stuck read error:", e instanceof Error ? e.message : "unknown")
    return NextResponse.json({ error: "Failed to read stuck work" }, { status: 500 })
  }
}
