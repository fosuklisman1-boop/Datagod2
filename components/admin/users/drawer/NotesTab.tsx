"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { adminJson, userApiPath } from "@/lib/admin-users/drawer-client"
import { NOTE_MAX_LENGTH } from "@/lib/admin-users/notes-tags"
import { ConfirmDialog, LoadState, dateTime, useAdminGet } from "./shared"
import type { NoteItem } from "./types"

/**
 * Admin notes about the user, newest first. Any admin can add a note and delete any note; only the author can
 * edit theirs. Every change is audited (Admin history tab).
 */
export function NotesTab({ userId, refreshKey = 0 }: { userId: string; refreshKey?: number }) {
  // The signed-in admin: only their own notes get an Edit button (the route enforces it too).
  const [currentAdminId, setCurrentAdminId] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setCurrentAdminId(data.session?.user.id ?? null)).catch(() => {})
  }, [])
  const { data, error, loading, reload } = useAdminGet<{ notes: NoteItem[]; limit: number }>(userApiPath(userId, "notes"), refreshKey)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [deleting, setDeleting] = useState<NoteItem | null>(null)

  const add = async () => {
    if (!draft.trim()) return
    setSaving(true)
    try {
      await adminJson(userApiPath(userId, "notes"), { method: "POST", body: { body: draft } })
      setDraft("")
      reload()
    } catch (e: any) {
      toast.error(e?.message || "Could not save the note")
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = async () => {
    if (!editing || !editing.body.trim()) return
    setSaving(true)
    try {
      await adminJson(`${userApiPath(userId, "notes")}/${encodeURIComponent(editing.id)}`, { method: "PATCH", body: { body: editing.body } })
      setEditing(null)
      reload()
    } catch (e: any) {
      toast.error(e?.message || "Could not save the note")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Textarea
          aria-label="New note"
          placeholder="Add a note for other admins (not shown to the user)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={NOTE_MAX_LENGTH}
          rows={3}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{draft.length}/{NOTE_MAX_LENGTH}</span>
          <Button size="sm" onClick={add} disabled={saving || !draft.trim()}>
            {saving && !editing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Add note
          </Button>
        </div>
      </div>

      <LoadState loading={loading && !data} error={error} onRetry={reload}
        empty={data && data.notes.length === 0 ? "No notes yet" : undefined}>
        <ul className={`divide-y border rounded-lg ${loading ? "opacity-60" : ""}`}>
          {data?.notes.map((n) => (
            <li key={n.id} className="px-3 py-2 text-sm space-y-1">
              <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>{n.author_email ?? (n.author_id ? n.author_id : "deleted admin")}</span>
                <span className="whitespace-nowrap">
                  {dateTime(n.created_at)}{n.updated_at !== n.created_at && " (edited)"}
                </span>
              </div>
              {editing?.id === n.id ? (
                <div className="space-y-2">
                  <Textarea aria-label="Edit note" value={editing.body} maxLength={NOTE_MAX_LENGTH} rows={3}
                    onChange={(e) => setEditing({ id: n.id, body: e.target.value })} />
                  <div className="flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
                    <Button size="sm" onClick={saveEdit} disabled={saving || !editing.body.trim()}>
                      {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <p className="flex-1 whitespace-pre-wrap break-words">{n.body}</p>
                  <div className="flex gap-1 shrink-0">
                    {currentAdminId && n.author_id === currentAdminId && (
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit note" onClick={() => setEditing({ id: n.id, body: n.body })}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label="Delete note" onClick={() => setDeleting(n)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {data && data.notes.length >= data.limit && (
          <p className="text-xs text-muted-foreground pt-2">Showing the newest {data.limit} notes.</p>
        )}
      </LoadState>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this note?"
        description={<p className="whitespace-pre-wrap break-words">{deleting?.body}</p>}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await adminJson(`${userApiPath(userId, "notes")}/${encodeURIComponent(deleting.id)}`, { method: "DELETE" })
            reload()
          } catch (e: any) {
            toast.error(e?.message || "Could not delete the note")
            throw e
          }
        }}
      />
    </div>
  )
}
