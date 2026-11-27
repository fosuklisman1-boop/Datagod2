import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { deleteOldConversations, deleteOldVoiceCalls, deleteOldVoiceQueue } from "@/lib/ai-console/retention"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  // Each job runs independently: a failure in one must not stop the other.
  let failed = false
  let deleted = 0
  let voiceCallsDeleted = 0
  let voiceQueueDeleted = 0
  try {
    deleted = await deleteOldConversations(supabase)
  } catch {
    failed = true
    console.error("[AI-CONVERSATIONS-RETENTION] conversations failed")
  }
  try {
    voiceCallsDeleted = await deleteOldVoiceCalls(supabase)
  } catch {
    failed = true
    console.error("[AI-CONVERSATIONS-RETENTION] voice calls failed")
  }
  try {
    voiceQueueDeleted = await deleteOldVoiceQueue(supabase)
  } catch {
    failed = true
    console.error("[AI-CONVERSATIONS-RETENTION] voice queue failed")
  }
  if (failed) {
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
  console.log("[AI-CONVERSATIONS-RETENTION] done", { deleted, voiceCallsDeleted, voiceQueueDeleted })
  return NextResponse.json({ success: true, data: { deleted, voiceCallsDeleted, voiceQueueDeleted } })
}
