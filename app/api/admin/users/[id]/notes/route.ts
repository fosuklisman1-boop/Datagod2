import { NextRequest, NextResponse } from "next/server"
import { badRequest, gateAdmin, serviceClient, userIdParam, writeAudit, type IdCtx } from "@/lib/admin-users/route-utils"
import { NOTES_PAGE_LIMIT, parseNoteBody } from "@/lib/admin-users/notes-tags"
import { withAuthorEmails, type NoteRow } from "@/lib/admin-users/notes-server"

export const dynamic = "force-dynamic"

/**
 * GET  /api/admin/users/[id]/notes   -> { notes: [{ id, body, author_id, author_email, created_at, updated_at }], limit }
 *      The newest NOTES_PAGE_LIMIT notes, newest first.
 * POST /api/admin/users/[id]/notes { body }   -> 201 { note }
 *      Signed-in admin only (no CRON bypass). Audited: 'user_note_create'.
 * Edit / delete: /api/admin/users/[id]/notes/[noteId].
 * public.admin_user_notes (0149) has RLS on and no policies: only these service-role routes reach it.
 */
export async function GET(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req)
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response

  const db = serviceClient()
  const { data, error } = await db
    .from("admin_user_notes")
    .select("id, user_id, author_id, body, created_at, updated_at")
    .eq("user_id", idp.id)
    .order("created_at", { ascending: false })
    .limit(NOTES_PAGE_LIMIT)
  if (error) {
    console.error("[ADMIN-USER-NOTES]", error.message)
    return NextResponse.json({ error: "Failed to load notes" }, { status: 500 })
  }
  return NextResponse.json({ notes: await withAuthorEmails(db, (data ?? []) as NoteRow[]), limit: NOTES_PAGE_LIMIT })
}

export async function POST(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req, { write: true })
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response
  const adminId = gate.adminId!

  const json = await req.json().catch(() => null)
  const parsed = parseNoteBody(json?.body)
  if (!parsed.ok) return badRequest(parsed.error)

  const db = serviceClient()
  const { data, error } = await db
    .from("admin_user_notes")
    .insert({ user_id: idp.id, author_id: adminId, body: parsed.body })
    .select("id, user_id, author_id, body, created_at, updated_at")
    .single()
  if (error) {
    // 23503: no such auth user.
    if (error.code === "23503") return NextResponse.json({ error: "User not found" }, { status: 404 })
    console.error("[ADMIN-USER-NOTES] insert:", error.message)
    return NextResponse.json({ error: "Failed to save the note" }, { status: 500 })
  }
  const note = data as NoteRow
  const audited = await writeAudit(db, {
    admin_id: adminId, action: "user_note_create", target_user_id: idp.id, new_value: { note_id: note.id, body: note.body },
  })
  return NextResponse.json({ note: { ...note, author_email: gate.adminEmail ?? null }, audited }, { status: 201 })
}
