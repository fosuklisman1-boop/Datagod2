import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { computeNextRun } from "@/lib/ai-scheduled/next-run"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveUser(request: NextRequest): Promise<{
  userId: string
  userRole: string
  isAdmin: boolean
  error?: NextResponse
}> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return { userId: "", userRole: "user", isAdmin: false, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }
  const token = authHeader.slice(7)

  // CRON_SECRET bypass — cron engine running admin tasks gets full admin access
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && token === cronSecret) {
    return { userId: "", userRole: "admin", isAdmin: true }
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !authData?.user?.id) {
    return { userId: "", userRole: "user", isAdmin: false, error: NextResponse.json({ error: "Invalid token" }, { status: 401 }) }
  }

  const { data: userData } = await supabase
    .from("users")
    .select("role")
    .eq("id", authData.user.id)
    .single()

  return {
    userId: authData.user.id,
    userRole: userData?.role ?? "user",
    isAdmin: userData?.role === "admin",
  }
}

// ─── computeNextRun ───────────────────────────────────────────────────────────

// computeNextRun lives in lib/ai-scheduled/next-run.ts (shared with the cron and standing orders).

// ─── GET: list tasks ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { userId, isAdmin, error } = await resolveUser(request)
  if (error) return error

  const { searchParams } = new URL(request.url)
  const scopeOwn = searchParams.get("scope") === "own"

  try {
    let query = supabase
      .from("ai_scheduled_tasks")
      .select("id, name, prompt, context, schedule_type, run_at_time, run_on_days, run_at_timestamp, notify_channels, next_run_at, last_run_at, last_result, last_success, is_active, user_id, created_at")
      .order("created_at", { ascending: false })

    // Non-admins (or admin requesting scope=own) see only their tasks
    if (!isAdmin || scopeOwn) {
      query = query.eq("user_id", userId)
    }

    const { data, error: dbError } = await query
    if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })
    return NextResponse.json({ tasks: data ?? [] })
  } catch (err) {
    console.error("[SCHEDULED-TASKS] GET error:", err)
    return NextResponse.json({ error: "Failed to fetch tasks" }, { status: 500 })
  }
}

// ─── POST: create task ────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const { userId, userRole, isAdmin, error } = await resolveUser(request)
  if (error) return error

  try {
    const body = await request.json()
    const { name, prompt, context, schedule_type, run_at_time, run_on_days, run_at_timestamp, notify_channels } = body

    if (!name || !prompt || !schedule_type) {
      return NextResponse.json({ error: "name, prompt, and schedule_type are required" }, { status: 400 })
    }
    if (!["once", "hourly", "daily", "weekly"].includes(schedule_type)) {
      return NextResponse.json({ error: "Invalid schedule_type" }, { status: 400 })
    }
    if ((schedule_type === "daily" || schedule_type === "weekly") && !run_at_time) {
      return NextResponse.json({ error: "run_at_time (HH:MM UTC) is required for daily/weekly tasks" }, { status: 400 })
    }
    if (schedule_type === "weekly" && (!run_on_days?.length)) {
      return NextResponse.json({ error: "run_on_days is required for weekly tasks" }, { status: 400 })
    }
    if (schedule_type === "once" && !run_at_timestamp) {
      return NextResponse.json({ error: "run_at_timestamp is required for once tasks" }, { status: 400 })
    }

    // Non-admins can only create dashboard-context tasks for themselves
    const taskContext = isAdmin ? (context ?? "admin") : "dashboard"

    const taskPayload = {
      name,
      prompt,
      context: taskContext,
      user_id: userId,
      user_role: userRole,
      schedule_type,
      run_at_time: run_at_time ?? null,
      run_on_days: run_on_days ?? null,
      run_at_timestamp: run_at_timestamp ?? null,
      notify_channels: notify_channels ?? ["push"],
      next_run_at: computeNextRun({ schedule_type, run_at_time, run_on_days, run_at_timestamp }).toISOString(),
      created_by: userId,
    }

    const { data, error: dbError } = await supabase
      .from("ai_scheduled_tasks")
      .insert(taskPayload)
      .select()
      .single()

    if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })
    return NextResponse.json({ task: data }, { status: 201 })
  } catch (err) {
    console.error("[SCHEDULED-TASKS] POST error:", err)
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 })
  }
}
