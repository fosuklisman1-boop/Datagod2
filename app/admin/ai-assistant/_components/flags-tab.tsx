"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { REVIEW_CHECKLIST } from "@/lib/ai-console/review"
import { authedFetch, ConversationRowCard, TranscriptDialog, type ListResponse } from "./review-shared"

export function FlagsTab() {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(false)
    try {
      const r = await authedFetch(`/api/admin/ai-conversations?flagged=true&reviewed=false&page=${page}`)
      if (!r.ok) throw new Error("x")
      setData(await r.json())
    } catch { setError(true) }
    setLoading(false)
  }, [page])

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

  const s = data?.summary
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Weekly review</CardTitle></CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[auto,1fr]">
          <div className="flex gap-6">
            <div><p className="text-2xl font-semibold text-primary">{s ? s.unreviewedFlagged7d : "-"}</p><p className="text-xs text-muted-foreground">unreviewed flags, last 7 days</p></div>
            <div><p className="text-2xl font-semibold">{s ? s.conversations7d : "-"}</p><p className="text-xs text-muted-foreground">conversations, last 7 days</p></div>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {REVIEW_CHECKLIST.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">Could not load flags. <button className="underline" onClick={load}>Try again</button></p>}
      {loading && !data && <p className="text-sm text-muted-foreground">Loading...</p>}
      {!loading && !error && (data?.conversations.length ?? 0) === 0 && (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">Nothing to review. Flagged conversations appear here.</div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {data?.conversations.map((c) => (
          <ConversationRowCard key={c.id} row={c} busy={busy} onOpen={() => setOpen(c.id)} onReview={() => review(c.id)} />
        ))}
      </div>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-muted-foreground">Page {data.page} of {data.totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= data.totalPages || loading} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      {open && <TranscriptDialog id={open} busy={busy} onClose={() => setOpen(null)} onReview={review} />}
    </div>
  )
}
