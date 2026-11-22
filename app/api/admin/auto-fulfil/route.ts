import { NextRequest, NextResponse } from "next/server"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { cancelWaitingAutoRows, readSwitches } from "@/lib/auto-fulfil/run"
import { AUTO_FULFIL_SETTINGS_KEY, loadAutoFulfilSettings, parseAutoFulfilSettings } from "@/lib/auto-fulfil/settings"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TAG = "[AUTO-FULFIL-SETTINGS]"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DESCRIPTION = "Auto-fulfil pending orders: switch, age gate, per-run cap, networks and retry rules"

/** Settings, the two existing switches, the latest run (counts only) and how many automatic rows wait in the queue. */
async function buildState(db: SupabaseClient) {
  const [{ settings, valid }, sw, runRes, countRes] = await Promise.all([
    loadAutoFulfilSettings(db),
    readSwitches(db),
    db
      .from("auto_fulfil_runs")
      .select("started_at, finished_at, queued, waiting, needs_you, error")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from("fulfillment_queue").select("id", { count: "exact", head: true }).eq("source", "auto").eq("status", "pending"),
  ])
  if (runRes.error) throw new Error(`latest run read failed: ${runRes.error.message}`)
  if (countRes.error) throw new Error(`waiting auto rows count failed: ${countRes.error.message}`)
  const run = runRes.data as Record<string, any> | null
  return {
    settings,
    valid,
    switches: { mtn: sw.mtn, nonMtn: { enabled: sw.nonMtn.size > 0, networks: Array.from(sw.nonMtn) } },
    lastRun: run
      ? {
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          queued: run.queued,
          waiting: run.waiting,
          needsYou: run.needs_you,
          error: run.error,
        }
      : null,
    waitingAutoRows: countRes.count ?? 0,
  }
}

const fail = (error: string, status = 500) => NextResponse.json({ error }, { status })
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? fail("Unauthorized", 401)
  try {
    return NextResponse.json(await buildState(supabase))
  } catch (e) {
    console.error(`${TAG} load failed: ${msg(e)}`)
    return fail("Could not load auto-fulfil settings")
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
  const parsed = parseAutoFulfilSettings(body)
  if (!parsed.ok) return fail(parsed.error, 400)
  const next = parsed.value

  // The old raw value for the audit log. A read failure must not block a save (switching off must always work).
  let oldValue: unknown = null
  const { data: oldRow, error: oldErr } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", AUTO_FULFIL_SETTINGS_KEY)
    .maybeSingle()
  if (oldErr) console.error(`${TAG} old value read failed: ${oldErr.message}`)
  else oldValue = (oldRow as { value: unknown } | null)?.value ?? null

  const { error: upErr } = await supabase.from("admin_settings").upsert(
    { key: AUTO_FULFIL_SETTINGS_KEY, value: next, description: DESCRIPTION, updated_at: new Date().toISOString(), updated_by: userId },
    { onConflict: "key" },
  )
  if (upErr) {
    console.error(`${TAG} save failed: ${upErr.message}`)
    return fail("Could not save auto-fulfil settings")
  }

  // Once saved, cancel waiting rows (when off) and write the audit row; one failing must not skip the other.
  const problems: string[] = []
  if (!next.enabled) {
    try {
      const n = await cancelWaitingAutoRows(supabase)
      console.log(`${TAG} switched off by admin ${userId}; cancelled ${n} waiting automatic rows`)
    } catch (e) {
      console.error(`${TAG} cancel waiting rows failed: ${msg(e)}`)
      problems.push("waiting automatic orders could not be cancelled")
    }
  }
  const { error: logErr } = await supabase
    .from("auto_fulfil_settings_log")
    .insert({ admin_id: userId, old_value: oldValue, new_value: next })
  if (logErr) {
    console.error(`${TAG} audit log insert failed: ${logErr.message}`)
    problems.push("the change could not be written to the audit log")
  }
  if (problems.length) return fail(`Settings saved, but ${problems.join(" and ")}`)

  try {
    return NextResponse.json(await buildState(supabase))
  } catch (e) {
    console.error(`${TAG} reload after save failed: ${msg(e)}`)
    return fail("Settings saved, but they could not be reloaded")
  }
}
