import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { deleteOldSupportData } from "@/lib/support-cleanup"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  const dryRun = request.nextUrl.searchParams.get("dry") === "1"
  try {
    const { closedThreads, legacyComplaints, filesRemoved, errors = 0 } = await deleteOldSupportData(supabase, new Date(), { dryRun })
    console.log("[SUPPORT-CLEANUP] done", { dryRun, closedThreads, legacyComplaints, filesRemoved, errors })
    return NextResponse.json({ success: true, data: { dryRun, closedThreads, legacyComplaints, filesRemoved, errors } })
  } catch {
    console.error("[SUPPORT-CLEANUP] failed", { dryRun })
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
