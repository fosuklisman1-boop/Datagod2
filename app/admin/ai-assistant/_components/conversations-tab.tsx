"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { authedFetch, ConversationRowCard, TranscriptDialog, type ListResponse } from "./review-shared"

export function ConversationsTab() {
  const [context, setContext] = useState("")
  const [flagged, setFlagged] = useState(false)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(false)
    const p = new URLSearchParams({ page: String(page) })
    if (context) p.set("context", context)
    if (flagged) p.set("flagged", "true")
    if (from) p.set("from", from)
    if (to) p.set("to", to)
    try {
      const r = await authedFetch(`/api/admin/ai-conversations?${p}`)
      if (!r.ok) throw new Error("x")
      setData(await r.json())
    } catch { setError(true) }
    setLoading(false)
  }, [page, context, flagged, from, to])

  useEffect(() => { load() }, [load])

  async function review(id: string) {
    setBusy(true)
    const r = await authedFetch(`/api/admin/ai-conversations/${id}/review`, { method: "POST" })
    setBusy(false)
    if (!r.ok) { toast.error("Could not mark reviewed"); return }
    toast.success("Marked reviewed")
    setOpen(null)
    load()
  }

  const change = (fn: () => void) => { fn(); setPage(1) }
  const empty = !loading && !error && (data?.conversations.length ?? 0) === 0
  const filtered = context || flagged || from || to

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1">
          <Label htmlFor="conv-context">Where</Label>
          <select id="conv-context" value={context} onChange={(e) => change(() => setContext(e.target.value))} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">All</option>
            <option value="home">Home page</option>
            <option value="storefront">Storefront</option>
            <option value="dashboard">Dashboard</option>
          </select>
        </div>
        <div className="space-y-1"><Label htmlFor="conv-from">From</Label><Input id="conv-from" type="date" value={from} onChange={(e) => change(() => setFrom(e.target.value))} className="w-40" /></div>
        <div className="space-y-1"><Label htmlFor="conv-to">To</Label><Input id="conv-to" type="date" value={to} onChange={(e) => change(() => setTo(e.target.value))} className="w-40" /></div>
        <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={flagged} onChange={(e) => change(() => setFlagged(e.target.checked))} /> Flagged only</label>
      </div>

      {error && <p className="text-sm text-destructive">Could not load conversations. <button className="underline" onClick={load}>Try again</button></p>}
      {loading && !data && <p className="text-sm text-muted-foreground">Loading...</p>}
      {empty && (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          {filtered ? "No conversations match these filters." : "No conversations yet — transcripts start after this update is deployed."}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {data?.conversations.map((c) => (
          <ConversationRowCard key={c.id} row={c} busy={busy} onOpen={() => setOpen(c.id)} onReview={() => review(c.id)} />
        ))}
      </div>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-muted-foreground">Page {data.page} of {data.totalPages} ({data.total} conversations)</span>
          <Button variant="outline" size="sm" disabled={page >= data.totalPages || loading} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      {open && <TranscriptDialog id={open} busy={busy} onClose={() => setOpen(null)} onReview={review} />}
    </div>
  )
}
