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

  // Fail safe: any `dry` value except an explicit "0" / "false" means dry run.
  // Every repeated `dry` value is read; one non-"0"/"false" value is enough.
  const dryRun = request.nextUrl.searchParams.getAll("dry").some((v) => !["0", "false"].includes(v.trim().toLowerCase()))
  try {
    const { closedThreads, legacyComplaints, filesRemoved, errors = 0 } = await deleteOldSupportData(supabase, new Date(), { dryRun })
    console.log("[SUPPORT-CLEANUP] done", { dryRun, closedThreads, legacyComplaints, filesRemoved, errors })
    return NextResponse.json({ success: true, data: { dryRun, closedThreads, legacyComplaints, filesRemoved, errors } })
  } catch {
    console.error("[SUPPORT-CLEANUP] failed", { dryRun })
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
