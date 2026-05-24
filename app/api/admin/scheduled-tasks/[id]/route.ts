import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function resolveUser(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return { userId: "", isAdmin: false, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }
  const token = authHeader.slice(7)

  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && token === cronSecret) {
    return { userId: "", isAdmin: true, error: undefined }
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !authData?.user?.id) {
    return { userId: "", isAdmin: false, error: NextResponse.json({ error: "Invalid token" }, { status: 401 }) }
  }
  const { data: userData } = await supabase
    .from("users")
    .select("role")
    .eq("id", authData.user.id)
    .single()
  return { userId: authData.user.id, isAdmin: userData?.role === "admin", error: undefined }
}

// ─── GET: fetch one task ──────────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId, isAdmin, error } = await resolveUser(request)
  if (error) return error

  const { id } = await params

  const { data, error: dbError } = await supabase
    .from("ai_scheduled_tasks")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (dbError || !data) return NextResponse.json({ error: "Task not found" }, { status: 404 })

  // Non-admins can only view their own tasks
  if (!isAdmin && data.user_id !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  return NextResponse.json({ task: data })
}

// ─── PATCH: toggle or update ──────────────────────────────────────────────────

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId, isAdmin, error } = await resolveUser(request)
  if (error) return error

  const { id } = await params

  // Verify ownership for non-admins
  if (!isAdmin) {
    const { data: existing } = await supabase
      .from("ai_scheduled_tasks")
      .select("user_id")
      .eq("id", id)
      .maybeSingle()
    if (!existing || existing.user_id !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
  }

  try {
    const body = await request.json()
    const updates: Record<string, unknown> = {}
    if (body.is_active !== undefined) updates.is_active = body.is_active
    if (body.prompt !== undefined) updates.prompt = body.prompt
    if (body.name !== undefined) updates.name = body.name

    const { data, error: dbError } = await supabase
      .from("ai_scheduled_tasks")
      .update(updates)
      .eq("id", id)
      .select()
      .single()

    if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })
    return NextResponse.json({ task: data, message: "Task updated" })
  } catch (err) {
    console.error("[SCHEDULED-TASKS] PATCH error:", err)
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 })
  }
}

// ─── DELETE: remove task ──────────────────────────────────────────────────────

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId, isAdmin, error } = await resolveUser(request)
  if (error) return error

  const { id } = await params

  // Non-admins can only delete their own tasks
  if (!isAdmin) {
    const { data: existing } = await supabase
      .from("ai_scheduled_tasks")
      .select("user_id")
      .eq("id", id)
      .maybeSingle()
    if (!existing || existing.user_id !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
  }

  const { error: dbError } = await supabase
    .from("ai_scheduled_tasks")
    .delete()
    .eq("id", id)

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })
  return NextResponse.json({ message: "Task deleted" })
}
