"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Trash2, Edit, Plus, X, Check } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

const CATEGORIES = ["faq", "policy", "product", "support", "delivery", "refund"]
const ALL_CONTEXTS = ["storefront", "dashboard", "admin"]

interface Entry {
  id: string
  category: string
  question: string
  answer: string
  contexts: string[]
  is_active: boolean
  created_at: string
}

const blank = (): Partial<Entry> => ({
  category: "faq",
  question: "",
  answer: "",
  contexts: ["storefront", "dashboard", "admin"],
  is_active: true,
})

export default function AIKnowledgePage() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Partial<Entry>>(blank())
  const [editId, setEditId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [token, setToken] = useState("")

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setToken(session.access_token)
    })
    fetchEntries()
  }, [])

  async function fetchEntries() {
    setLoading(true)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch("/api/admin/ai-knowledge", {
      headers: { Authorization: `Bearer ${session?.access_token}` },
    })
    const data = await res.json()
    setEntries(data.entries ?? [])
    setLoading(false)
  }

  async function save() {
    if (!form.question?.trim() || !form.answer?.trim()) {
      toast.error("Question and answer are required")
      return
    }
    setSaving(true)
    const { data: { session } } = await supabase.auth.getSession()
    const method = editId ? "PATCH" : "POST"
    const body = editId ? { id: editId, ...form } : form
    const res = await fetch("/api/admin/ai-knowledge", {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); setSaving(false); return }
    toast.success(editId ? "Entry updated" : "Entry added")
    setForm(blank())
    setEditId(null)
    setShowForm(false)
    fetchEntries()
    setSaving(false)
  }

  async function toggleActive(entry: Entry) {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch("/api/admin/ai-knowledge", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ id: entry.id, is_active: !entry.is_active }),
    })
    if (res.ok) {
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, is_active: !e.is_active } : e))
      toast.success(entry.is_active ? "Entry disabled" : "Entry enabled")
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this entry?")) return
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`/api/admin/ai-knowledge?id=${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session?.access_token}` },
    })
    if (res.ok) {
      setEntries(prev => prev.filter(e => e.id !== id))
      toast.success("Deleted")
    }
  }

  function startEdit(entry: Entry) {
    setForm({ category: entry.category, question: entry.question, answer: entry.answer, contexts: entry.contexts, is_active: entry.is_active })
    setEditId(entry.id)
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  function cancelForm() {
    setForm(blank())
    setEditId(null)
    setShowForm(false)
  }

  function toggleContext(ctx: string) {
    const current = form.contexts ?? []
    setForm(f => ({
      ...f,
      contexts: current.includes(ctx) ? current.filter(c => c !== ctx) : [...current, ctx],
    }))
  }

  const grouped = CATEGORIES.map(cat => ({
    cat,
    items: entries.filter(e => e.category === cat),
  })).filter(g => g.items.length > 0)

  const uncategorised = entries.filter(e => !CATEGORIES.includes(e.category))

  return (
    <DashboardLayout>
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">AI Knowledge Base</h1>
            <p className="text-sm text-muted-foreground mt-1">Entries the AI searches when answering user questions</p>
          </div>
          {!showForm && (
            <Button onClick={() => setShowForm(true)} className="gap-2">
              <Plus size={16} /> Add Entry
            </Button>
          )}
        </div>

        {showForm && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{editId ? "Edit Entry" : "New Entry"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>Category</Label>
                  <select
                    value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card"
                  >
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Visible to</Label>
                  <div className="flex gap-2 mt-1">
                    {ALL_CONTEXTS.map(ctx => (
                      <button
                        key={ctx}
                        type="button"
                        onClick={() => toggleContext(ctx)}
                        className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                          form.contexts?.includes(ctx)
                            ? "bg-violet-600 text-white border-violet-600"
                            : "bg-card text-muted-foreground border-border"
                        }`}
                      >
                        {ctx}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-1">
                <Label>Question / Topic</Label>
                <Input
                  value={form.question}
                  onChange={e => setForm(f => ({ ...f, question: e.target.value }))}
                  placeholder="e.g. How long does delivery take?"
                />
              </div>

              <div className="space-y-1">
                <Label>Answer</Label>
                <textarea
                  value={form.answer}
                  onChange={e => setForm(f => ({ ...f, answer: e.target.value }))}
                  rows={4}
                  placeholder="Write the full answer the AI should give..."
                  className="w-full text-sm border border-border rounded-lg px-3 py-2 outline-none focus:border-violet-400 resize-none"
                />
              </div>

              <div className="flex gap-2">
                <Button onClick={save} disabled={saving} className="gap-2">
                  <Check size={15} /> {saving ? "Saving..." : editId ? "Update" : "Add"}
                </Button>
                <Button variant="ghost" onClick={cancelForm} className="gap-2">
                  <X size={15} /> Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>
        ) : entries.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground text-sm">
              No entries yet. Add your first knowledge base entry above.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {[...grouped, ...(uncategorised.length ? [{ cat: "other", items: uncategorised }] : [])].map(({ cat, items }) => (
              <div key={cat}>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{cat}</h2>
                <div className="space-y-2">
                  {items.map(entry => (
                    <Card key={entry.id} className={entry.is_active ? "" : "opacity-50"}>
                      <CardContent className="py-3 px-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground">{entry.question}</p>
                            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{entry.answer}</p>
                            <div className="flex gap-1 mt-2 flex-wrap">
                              {entry.contexts.map(ctx => (
                                <Badge key={ctx} variant="secondary" className="text-xs">{ctx}</Badge>
                              ))}
                              {!entry.is_active && <Badge variant="outline" className="text-xs text-muted-foreground">disabled</Badge>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => toggleActive(entry)}
                              title={entry.is_active ? "Disable" : "Enable"}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            >
                              <Check size={15} />
                            </button>
                            <button
                              onClick={() => startEdit(entry)}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            >
                              <Edit size={15} />
                            </button>
                            <button
                              onClick={() => remove(entry.id)}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
