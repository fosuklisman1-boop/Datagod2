"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { fetchAudit, type AuditEntry } from "../_lib/api"

export function AuditTab({ roleId }: { roleId: string }) {
  const [page, setPage] = useState(1) // the route's pages are 1-based
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (p: number) => {
      setLoading(true)
      setError(null)
      try {
        const data = await fetchAudit(roleId, p)
        setEntries(data.entries)
        setHasMore(data.has_more)
        setPage(data.page)
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load history"
        setError(msg)
        toast.error(msg)
      } finally {
        setLoading(false)
      }
    },
    [roleId],
  )

  useEffect(() => {
    load(1)
  }, [load])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">History</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No history yet.</p>
        ) : (
          <ul className="divide-y">
            {entries.map((e, i) => (
              <li key={`${e.at}-${i}`} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{e.summary}</span>
                  {e.loss_override ? (
                    <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
                      Loss override
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(e.at).toLocaleString()} · {e.actor_email ?? e.actor_id ?? "system"} · {e.action}
                </p>
                {e.reason ? <p className="text-xs">Reason: {e.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => load(page - 1)}>
            Newer
          </Button>
          <span className="text-xs text-muted-foreground">Page {page}</span>
          <Button variant="outline" size="sm" disabled={loading || !hasMore} onClick={() => load(page + 1)}>
            Older
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
