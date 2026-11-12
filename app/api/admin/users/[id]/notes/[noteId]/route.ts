import { NextRequest, NextResponse } from "next/server"
import { badRequest, gateAdmin, serviceClient, userIdParam, writeAudit } from "@/lib/admin-users/route-utils"
import { isUuid } from "@/lib/admin-users/drawer-params"
import { parseNoteBody } from "@/lib/admin-users/notes-tags"
import type { NoteRow } from "@/lib/admin-users/notes-server"

export const dynamic = "force-dynamic"

type NoteCtx = { params: Promise<{ id: string; noteId: string }> }

/**
 * PATCH  /api/admin/users/[id]/notes/[noteId] { body }  -> { note }   only the note's author may edit it
 * DELETE /api/admin/users/[id]/notes/[noteId]           -> { deleted: true }   any admin may delete
 * Signed-in admin only (no CRON bypass). Audited: 'user_note_update' (old and new body), 'user_note_delete'.
 */
async function load(req: NextRequest, ctx: NoteCtx) {
  const gate = await gateAdmin(req, { write: true })
  if (!gate.ok) return { ok: false as const, response: gate.response }
  const idp = await userIdParam(ctx)
  if (!idp.ok) return { ok: false as const, response: idp.response }
  const { noteId } = await ctx.params
  if (!isUuid(noteId)) return { ok: false as const, response: badRequest("Invalid note id") }

  const db = serviceClient()
  const { data, error } = await db
    .from("admin_user_notes")
    .select("id, user_id, author_id, body, created_at, updated_at")
    .eq("id", noteId)
    .eq("user_id", idp.id)
    .maybeSingle()
  if (error) {
    console.error("[ADMIN-USER-NOTES] load:", error.message)
    return { ok: false as const, response: NextResponse.json({ error: "Failed to load the note" }, { status: 500 }) }
  }
  if (!data) return { ok: false as const, response: NextResponse.json({ error: "Note not found" }, { status: 404 }) }
  return { ok: true as const, db, adminId: gate.adminId!, adminEmail: gate.adminEmail ?? null, userId: idp.id, note: data as NoteRow }
}

export async function PATCH(req: NextRequest, ctx: NoteCtx) {
  const l = await load(req, ctx)
  if (!l.ok) return l.response
  if (l.note.author_id !== l.adminId) {
    return NextResponse.json({ error: "Only the admin who wrote a note can edit it" }, { status: 403 })
  }
  const json = await req.json().catch(() => null)
  const parsed = parseNoteBody(json?.body)
  if (!parsed.ok) return badRequest(parsed.error)
  if (parsed.body === l.note.body) return NextResponse.json({ note: { ...l.note, author_email: l.adminEmail }, changed: false })

  const { data, error } = await l.db
    .from("admin_user_notes")
    .update({ body: parsed.body, updated_at: new Date().toISOString() })
    .eq("id", l.note.id)
    .eq("author_id", l.adminId)
    .select("id, user_id, author_id, body, created_at, updated_at")
    .maybeSingle()
  if (error) {
    console.error("[ADMIN-USER-NOTES] update:", error.message)
    return NextResponse.json({ error: "Failed to save the note" }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: "Note not found" }, { status: 404 })
  const audited = await writeAudit(l.db, {
    admin_id: l.adminId, action: "user_note_update", target_user_id: l.userId,
    old_value: { note_id: l.note.id, body: l.note.body }, new_value: { note_id: l.note.id, body: parsed.body },
  })
  return NextResponse.json({ note: { ...(data as NoteRow), author_email: l.adminEmail }, changed: true, audited })
}

export async function DELETE(req: NextRequest, ctx: NoteCtx) {
  const l = await load(req, ctx)
  if (!l.ok) return l.response
  const { error } = await l.db.from("admin_user_notes").delete().eq("id", l.note.id)
  if (error) {
    console.error("[ADMIN-USER-NOTES] delete:", error.message)
    return NextResponse.json({ error: "Failed to delete the note" }, { status: 500 })
  }
  const audited = await writeAudit(l.db, {
    admin_id: l.adminId, action: "user_note_delete", target_user_id: l.userId,
    old_value: { note_id: l.note.id, body: l.note.body, author_id: l.note.author_id },
  })
  return NextResponse.json({ deleted: true, audited })
}
