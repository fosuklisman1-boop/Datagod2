"use client"

import { useCallback, useEffect, useState } from "react"
import { Inbox, Loader2, Search } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { ApprovalItem } from "@/lib/api-v2/approvals"
import { adminFetch } from "../admin-fetch"
import { Eyebrow, InlineError, Panel } from "../ui"
import { ApprovalCard } from "./ApprovalCard"
import { ContactSetting } from "./ContactSetting"
import { GrantsList, HistoryList } from "./GrantsAndHistory"

const PAGE = 25

/** How many requests wait (live keys + access requests), for the tab badge. Null while unknown. */
export function useApprovalCount(): { count: number | null; refresh: () => Promise<void> } {
  const [count, setCount] = useState<number | null>(null)
  const refresh = useCallback(async () => {
    const r = await adminFetch<{ total: number }>("/api/admin/api-v2/approvals")
    if (r.ok && r.data) setCount(r.data.total)
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  return { count, refresh }
}

/** Screen E (design 5E): the approvals inbox, the contact setting, grants and history. */
export function ApprovalsPanel({ onChanged }: { onChanged?: () => void }) {
  const [q, setQ] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const [data, setData] = useState<{ items: ApprovalItem[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [historyKey, setHistoryKey] = useState(0)

  const load = useCallback(async () => {
    const r = await adminFetch<{ items: ApprovalItem[]; total: number }>(
      `/api/admin/api-v2/approvals?q=${encodeURIComponent(query)}&page=${page}`
    )
    if (r.ok && r.data) {
      setData(r.data)
      setError(null)
    } else setError(r.error ?? "Could not load approvals")
  }, [query, page])
  useEffect(() => { void load() }, [load])

  const decide = async (item: ApprovalItem, action: "approve" | "reject", reason?: string) => {
    setBusy(item.id)
    const r = await adminFetch<{ ok?: boolean }>(`/api/admin/api-v2/approvals/${encodeURIComponent(item.id)}`, {
      method: "POST",
      body: JSON.stringify({ kind: item.kind, action, reason }),
    })
    setBusy(null)
    if (r.ok) toast.success(action === "approve" ? `Approved ${item.code}` : `Rejected ${item.code}`)
    else toast.error(r.error ?? "Could not save the decision")
    // A 409 means someone else changed it: the refresh shows the current state.
    await load()
    setHistoryKey((k) => k + 1)
    onChanged?.()
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Eyebrow>Waiting for approval{data ? ` (${data.total})` : ""}</Eyebrow>
            <form
              className="flex w-full min-w-0 gap-2 sm:w-auto"
              onSubmit={(e) => { e.preventDefault(); setPage(0); setQuery(q.trim()) }}
            >
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                maxLength={100}
                placeholder="Code, name, email or phone"
                aria-label="Search approvals"
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm sm:w-64"
              />
              <Button type="submit" size="sm" variant="outline" className="h-9 rounded-lg"><Search className="size-3.5" aria-hidden /> Search</Button>
            </form>
          </div>

          {error ? (
            <InlineError message={error} onRetry={() => void load()} />
          ) : !data ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading…</div>
          ) : data.items.length === 0 ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Inbox className="size-4" aria-hidden /> {query ? "Nothing matches that search." : "Nothing is waiting."}</p>
          ) : (
            <div className="space-y-3">
              {data.items.map((item) => (
                <ApprovalCard key={`${item.kind}:${item.id}`} item={item} busy={busy === item.id} onDecide={(a, r) => void decide(item, a, r)} />
              ))}
            </div>
          )}

          {data && pages > 1 && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <Button size="sm" variant="outline" className="h-9 rounded-lg" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="text-muted-foreground">Page {page + 1} of {pages}</span>
              <Button size="sm" variant="outline" className="h-9 rounded-lg" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </Panel>

        <div className="min-w-0 space-y-5">
          <ContactSetting />
          <GrantsList key={`g${historyKey}`} />
        </div>
      </div>
      <HistoryList key={`h${historyKey}`} />
    </div>
  )
}
