"use client"

import { useCallback, useEffect, useState } from "react"
import { api } from "../_lib/api"
import { calculateSegments } from "@/lib/sms/segments"

interface Template {
  id: string
  name: string
  body: string
  updated_at: string
}

export default function TemplatesTab() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [name, setName] = useState("")
  const [body, setBody] = useState("")
  const [editing, setEditing] = useState<Template | null>(null)
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await api<Template[]>("/api/admin/sms-templates")
    if (res.success && res.data) setTemplates(res.data)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function resetForm() {
    setEditing(null)
    setName("")
    setBody("")
  }

  async function save() {
    if (!name.trim() || !body.trim()) {
      setMsg("Name and body are required.")
      return
    }
    setBusy(true)
    setMsg("")
    const res = editing
      ? await api(`/api/admin/sms-templates/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, body }),
        })
      : await api("/api/admin/sms-templates", {
          method: "POST",
          body: JSON.stringify({ name, body }),
        })
    setBusy(false)
    if (res.success) {
      setMsg(editing ? "Template updated." : "Template created.")
      resetForm()
      await load()
    } else {
      setMsg(`Error: ${res.error}`)
    }
  }

  function startEdit(t: Template) {
    setEditing(t)
    setName(t.name)
    setBody(t.body)
  }

  async function remove(t: Template) {
    if (!confirm(`Delete template "${t.name}"?`)) return
    setBusy(true)
    const res = await api(`/api/admin/sms-templates/${t.id}`, { method: "DELETE" })
    setBusy(false)
    if (res.success) {
      if (editing?.id === t.id) resetForm()
      await load()
    } else {
      setMsg(`Error: ${res.error}`)
    }
  }

  const seg = calculateSegments(body)

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm rounded border bg-muted/40 px-3 py-2">{msg}</p>}

      {/* Editor */}
      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold">{editing ? `Edit “${editing.name}”` : "New template"}</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Template name"
          maxLength={100}
          className="w-full rounded border px-2 py-1 text-sm"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message body — use [FirstName], [LastName], [Phone] for personalisation"
          maxLength={1000}
          rows={4}
          className="w-full rounded border px-2 py-1 text-sm"
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {body.length} chars · {seg.encoding.toUpperCase()} · {seg.segments} segment
            {seg.segments === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            {editing && (
              <button onClick={resetForm} className="rounded border px-3 py-1 hover:bg-accent">
                Cancel
              </button>
            )}
            <button
              onClick={save}
              disabled={busy}
              className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
            >
              {editing ? "Update" : "Create"}
            </button>
          </div>
        </div>
      </section>

      {/* List */}
      <section className="rounded-lg border p-4 space-y-2">
        <h2 className="font-semibold">Templates ({templates.length})</h2>
        {templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No templates yet.</p>
        ) : (
          <ul className="divide-y">
            {templates.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{t.name}</p>
                  <p className="truncate text-sm text-muted-foreground">{t.body}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button onClick={() => startEdit(t)} className="rounded border px-2 py-1 text-xs hover:bg-accent">
                    Edit
                  </button>
                  <button
                    onClick={() => remove(t)}
                    className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
