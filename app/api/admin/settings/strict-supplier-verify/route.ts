import { NextRequest, NextResponse } from "next/server"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { STRICT_VERIFY_KEY, isStrictVerifyOn } from "@/lib/strict-verify/settings"
import { buildCandidates } from "@/lib/strict-verify/send"
import { canCheck } from "@/lib/strict-verify/ask"
import { getProviderDisplay } from "@/lib/mtn-providers/provider-display"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TAG = "[STRICT-VERIFY-SETTINGS]"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DESCRIPTION = "Strict supplier verification: only send an MTN order to a supplier that approved the number itself"

const fail = (error: string, status = 500) => NextResponse.json({ error }, { status })

/** One warning per sending supplier (primary + retry sequence) that cannot check numbers. Never throws. */
async function buildWarnings(db: SupabaseClient): Promise<string[]> {
  try {
    const { candidates, disabled } = await buildCandidates(db)
    return candidates
      .filter((s) => !canCheck(s, disabled))
      .map((s) => `${getProviderDisplay(s).label} can't check numbers right now, so it will receive no MTN orders in strict mode`)
  } catch {
    console.error(`${TAG} could not read supplier settings`)
    return ["Couldn't read the MTN supplier settings"]
  }
}

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? fail("Unauthorized", 401)
  try {
    const [enabled, warnings] = await Promise.all([isStrictVerifyOn(supabase), buildWarnings(supabase)])
    return NextResponse.json({ enabled, warnings })
  } catch {
    console.error(`${TAG} load failed`)
    return fail("Could not load the setting")
  }
}

export async function PUT(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? fail("Unauthorized", 401)
  // Cron-secret calls carry no user: a money switch change must be attributable to a person.
  if (!userId || !UUID_RE.test(userId)) return fail("admin_user_required", 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail("Request body must be JSON", 400)
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled
  if (typeof enabled !== "boolean") return fail("'enabled' must be a boolean", 400)

  // Deploy order: migration 0194 must exist before the switch can go on (turning OFF is always allowed).
  if (enabled) {
    let readError: { code?: string } | null = null
    try {
      const { error: holdsError } = await supabase.from("mtn_strict_holds").select("order_id").limit(1)
      readError = holdsError
    } catch {
      readError = { code: "thrown" }
    }
    if (readError) {
      if (readError.code === "42P01" || readError.code === "PGRST205") {
        console.error(`${TAG} refused enable: strict tables missing`)
        return fail("strict_tables_missing", 409)
      }
      console.error(`${TAG} refused enable: holds table read failed`)
      return fail("Could not confirm the strict-verification tables; try again", 503)
    }
  }

  const { error } = await supabase.from("admin_settings").upsert(
    { key: STRICT_VERIFY_KEY, value: { enabled }, description: DESCRIPTION, updated_at: new Date().toISOString(), updated_by: userId },
    { onConflict: "key" },
  )
  if (error) {
    console.error(`${TAG} save failed`)
    return fail("Could not save the setting")
  }
  console.log(`${TAG} set to ${enabled ? "on" : "off"} by admin ${userId}`)
  return NextResponse.json({ enabled, warnings: await buildWarnings(supabase) })
}
