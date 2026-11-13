"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { adminFetch, ApiError, type AdminMessage, type MessagesPage } from "./api"
import { OUTCOME_VALUES, outcomeLabel, outcomeTone, ttbErrorMessage } from "./format"
import { ThreadDialog } from "./ThreadDialog"

const selectCls = "h-9 rounded-md border bg-background px-2 text-sm"
type Filters = { outcome: string; phone: string }
const EMPTY: Filters = { outcome: "", phone: "" }

function listPath(f: Filters, cursor: string | null): string {
  const p = new URLSearchParams({ limit: "50" })
  if (f.outcome) p.set("outcome", f.outcome)
  if (f.phone.trim()) p.set("sender", f.phone.trim())
  if (cursor) p.set("cursor", cursor)
  return `/api/admin/text-to-buy/messages?${p.toString()}`
}

/**
 * Customer texts and numbers live in component state only: nothing goes in the page URL, nothing is logged, nothing is
 * cached (the API answers no-store). Filters are sent to the API, never written to the address bar.
 */
export function MessagesTab() {
  const [draft, setDraft] = useState<Filters>(EMPTY)
  const [applied, setApplied] = useState<Filters>(EMPTY)
  const [rows, setRows] = useState<AdminMessage[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<{ sender: string; messageId: string } | null>(null)
  const seq = useRef(0)

  const load = useCallback(async (f: Filters, after: string | null) => {
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const page = await adminFetch<MessagesPage>(listPath(f, after))
      if (mine !== seq.current) return
      setRows((prev) => (after ? [...prev, ...page.rows] : page.rows))
      setCursor(page.nextCursor)
    } catch (e) {
      if (mine === seq.current) setError(ttbErrorMessage(e instanceof ApiError ? e.code : undefined))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(applied, null)
  }, [applied, load])

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setApplied(draft)
        }}
      >
        <div>
          <label className="block text-xs text-muted-foreground" htmlFor="ttb-outcome">Outcome</label>
          <select id="ttb-outcome" className={selectCls} value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}>
            <option value="">All</option>
            {OUTCOME_VALUES.map((o) => <option key={o} value={o}>{outcomeLabel(o)}</option>)}
          </select>
        </div>
        <div className="min-w-[10rem] flex-1 lg:max-w-xs">
          <label className="block text-xs text-muted-foreground" htmlFor="ttb-phone">Phone number</label>
          <Input id="ttb-phone" inputMode="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="0200000101" />
        </div>
        <Button type="submit" disabled={loading}><Search className="mr-1 h-4 w-4" />Apply</Button>
        <Button type="button" variant="outline" onClick={() => { setDraft(EMPTY); setApplied(EMPTY) }}>Clear</Button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Sender</TableHead>
              <TableHead>Text</TableHead>
              <TableHead>Read by</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Order</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{loading ? "Loading..." : "No messages match."}</TableCell></TableRow>
            )}
            {rows.map((m) => (
              <TableRow
                key={m.id}
                tabIndex={0}
                role="button"
                aria-label="Open conversation"
                className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                onClick={() => setOpen({ sender: m.sender, messageId: m.id })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setOpen({ sender: m.sender, messageId: m.id })
                  }
                }}
              >
                <TableCell className="whitespace-nowrap text-xs">{new Date(m.createdAt).toLocaleString()}</TableCell>
                <TableCell className="font-mono text-xs">{m.sender}</TableCell>
                <TableCell className="min-w-[12rem] max-w-[22rem] whitespace-pre-wrap break-words text-xs">
                  {m.body}
                  {m.misread && <span className="ml-1 text-amber-700 dark:text-amber-300">(misread)</span>}
                </TableCell>
                <TableCell className="text-xs">{m.readBy === "ai" ? "AI" : m.readBy === "rules" ? "Rules" : "-"}</TableCell>
                <TableCell>
                  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${outcomeTone(m.outcome)}`}>{outcomeLabel(m.outcome)}</span>
                </TableCell>
                {/* There is no admin screen that shows one USSD order by id, so the id is plain text. */}
                <TableCell className="max-w-[8rem] truncate font-mono text-[11px]" title={m.orderLinkId ?? undefined}>{m.orderLinkId ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {cursor && (
        <Button variant="outline" onClick={() => void load(applied, cursor)} disabled={loading}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Load more
        </Button>
      )}

      <ThreadDialog target={open} onClose={() => setOpen(null)} onChanged={() => void load(applied, null)} />
    </div>
  )
}
