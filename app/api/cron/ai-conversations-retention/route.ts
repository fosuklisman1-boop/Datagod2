import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { deleteOldConversations } from "@/lib/ai-console/retention"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  try {
    const deleted = await deleteOldConversations(supabase)
    console.log("[AI-CONVERSATIONS-RETENTION] done", { deleted })
    return NextResponse.json({ success: true, data: { deleted } })
  } catch {
    console.error("[AI-CONVERSATIONS-RETENTION] failed")
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
