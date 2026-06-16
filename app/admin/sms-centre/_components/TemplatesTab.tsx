"use client"

import { useCallback, useEffect, useState } from "react"
import { api } from "../_lib/api"
import { calculateSegments } from "@/lib/sms/segments"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react"

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
      toast.error("Name and body are required.")
      return
    }
    setBusy(true)
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
      toast.success(editing ? "Template updated." : "Template created.")
      resetForm()
      await load()
    } else {
      toast.error(res.error ?? "Failed to save template")
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
      toast.success("Template deleted.")
      await load()
    } else {
      toast.error(res.error ?? "Failed to delete template")
    }
  }

  const seg = calculateSegments(body)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Editor */}
      <Card className="self-start">
        <CardHeader>
          <CardTitle className="text-base">{editing ? `Edit "${editing.name}"` : "New template"}</CardTitle>
          <CardDescription>Reusable message bodies for broadcasts.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tplName">Name</Label>
            <Input id="tplName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" maxLength={100} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tplBody">Body</Label>
            <Textarea
              id="tplBody"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Message body — use [FirstName], [LastName], [Phone] for personalisation"
              maxLength={1000}
              rows={5}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {body.length} chars · {seg.encoding.toUpperCase()} · {seg.segments} segment{seg.segments === 1 ? "" : "s"}
            </span>
            <div className="flex gap-2">
              {editing && (
                <Button variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              )}
              <Button onClick={save} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {editing ? "Update" : "Create"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Templates ({templates.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No templates yet.</p>
          ) : (
            <ul className="divide-y">
              {templates.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">{t.name}</p>
                    <p className="truncate text-sm text-muted-foreground">{t.body}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(t)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => remove(t)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
