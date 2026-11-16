// Server-side helpers for the admin user notes routes.
import type { SupabaseClient } from "@supabase/supabase-js"

export interface NoteRow {
  id: string
  user_id: string
  author_id: string | null
  body: string
  created_at: string
  updated_at: string
}

/** The notes with each author's email (one users lookup for the distinct authors). */
export async function withAuthorEmails(db: SupabaseClient, notes: NoteRow[]) {
  const ids = [...new Set(notes.map((n) => n.author_id).filter((x): x is string => !!x))]
  const emails = new Map<string, string>()
  if (ids.length) {
    const { data, error } = await db.from("users").select("id, email").in("id", ids)
    if (error) console.warn("[ADMIN-USER-NOTES] author emails:", error.message)
    for (const a of (data ?? []) as Array<{ id: string; email: string | null }>) if (a.email) emails.set(a.id, a.email)
  }
  return notes.map((n) => ({ ...n, author_email: n.author_id ? emails.get(n.author_id) ?? null : null }))
}
