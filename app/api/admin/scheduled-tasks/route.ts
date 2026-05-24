import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveUser(request: NextRequest): Promise<{
  userId: string
  isAdmin: boolean
  error?: NextResponse
}> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return { userId: "", isAdmin: false, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }
  const token = authHeader.slice(7)

  const { data: authData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !authData?.user?.id) {
    return { userId: "", isAdmin: false, error: NextResponse.json({ error: "Invalid token" }, { status: 401 }) }
  }

  const { data: userData } = await supabase
    .from("users")
    .select("role")
    .eq("id", authData.user.id)
    .single()

  return {
    userId: authData.user.id,
    isAdmin: userData?.role === "admin",
  }
}

// ─── computeNextRun ───────────────────────────────────────────────────────────

function computeNextRun(task: {
  schedule_type: string
  run_at_time?: string | null
  run_on_days?: number[] | null
  run_at_timestamp?: string | null
}): Date {
  const now = new Date()

  if (task.schedule_type === "once") {
    return task.run_at_timestamp ? new Date(task.run_at_timestamp) : now
  }

  if (task.schedule_type === "hourly") {
    const next = new Date(now)
    next.setUTCMinutes(0, 0, 0)
    next.setUTCHours(next.getUTCHours() + 1)
    return next
  }

  if (task.schedule_type === "daily" && task.run_at_time) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    const candidate = new Date(now)
    candidate.setUTCHours(hh, mm, 0, 0)
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1)
    return candidate
  }

  if (task.schedule_type === "weekly" && task.run_at_time && task.run_on_days?.length) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(now)
      candidate.setUTCDate(candidate.getUTCDate() + offset)
      candidate.setUTCHours(hh, mm, 0, 0)
      if (task.run_on_days.includes(candidate.getUTCDay()) && candidate > now) {
        return candidate
      }
    }
  }

  // Fallback: 1 hour from now
  return new Date(now.getTime() + 60 * 60 * 1000)
}

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
  const { userId, isAdmin, error } = await resolveUser(request)
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
      user_role: isAdmin ? "admin" : "user",
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
