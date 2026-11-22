"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { X } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { supabase } from "@/lib/supabase"
import { reasonLabel } from "@/lib/ai-console/review"

export interface ConversationRow {
  id: string
  context: string
  audience: string
  user: string
  shop: string
  started_at: string
  last_at: string
  message_count: number
  flagged: boolean
  flag_reasons: string[]
  reviewed_at: string | null
  preview: string
}

export interface ListResponse {
  page: number
  total: number
  totalPages: number
  summary: { conversations7d: number; unreviewedFlagged7d: number }
  conversations: ConversationRow[]
}

export async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession()
  return fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${session?.access_token}` } })
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

export function ReasonChips({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1">
      {reasons.map((r) => (
        <Badge key={r} variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300">{reasonLabel(r)}</Badge>
      ))}
    </span>
  )
}

export function ConversationRowCard({ row, onOpen, onReview, busy }: { row: ConversationRow; onOpen: () => void; onReview?: () => void; busy?: boolean }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 space-y-1.5 text-left">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{row.audience}</span>
          <span>{row.context}</span>
          {row.user && <span>user {row.user}</span>}
          {row.shop && <span>shop {row.shop}</span>}
          <span>{fmtTime(row.last_at)}</span>
          <span>{row.message_count} messages</span>
          {row.flagged && row.reviewed_at && <Badge variant="secondary">Reviewed</Badge>}
        </div>
        {row.preview && <p className="line-clamp-2 break-words text-sm text-foreground">{row.preview}</p>}
        <ReasonChips reasons={row.flag_reasons} />
      </button>
      {onReview && row.flagged && !row.reviewed_at && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onReview}>Mark reviewed</Button>
      )}
    </div>
  )
}

interface Detail {
  conversation: Omit<ConversationRow, "preview">
  messages: Array<{ role: string; text: string; created_at: string }>
}

export function TranscriptDialog({ id, onClose, onReview, busy }: { id: string; onClose: () => void; onReview: (id: string) => void; busy: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setDetail(null); setFailed(false)
    authedFetch(`/api/admin/ai-conversations/${id}`)
      .then(async (r) => { if (!r.ok) throw new Error("x"); return r.json() })
      .then((d) => { if (live) setDetail(d) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [id])

  const c = detail?.conversation
  return (
    // Radix Dialog: Escape closes, focus moves in on open and back to the opener on close, Tab stays inside.
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-0 rounded-2xl bg-background p-0 sm:max-w-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0 space-y-1">
            <DialogTitle className="text-sm font-semibold leading-normal">{c ? `${c.audience} conversation` : "Conversation"}</DialogTitle>
            {c && <p className="text-xs text-muted-foreground">{c.context} · {c.message_count} messages · {fmtTime(c.started_at)}{c.user ? ` · user ${c.user}` : ""}{c.shop ? ` · shop ${c.shop}` : ""}</p>}
            {c && <ReasonChips reasons={c.flag_reasons} />}
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {failed && <p className="text-sm text-destructive">Could not load this conversation.</p>}
          {!detail && !failed && <p className="text-sm text-muted-foreground">Loading...</p>}
          {detail?.messages.map((m, i) => (
            <div key={i} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}>
              <span className="mb-0.5 text-[11px] text-muted-foreground">{m.role === "user" ? "Customer" : "Assistant"} · {fmtTime(m.created_at)}</span>
              <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}>{m.text}</div>
            </div>
          ))}
        </div>
        {c?.flagged && !c.reviewed_at && (
          <div className="border-t border-border p-3">
            <Button disabled={busy} onClick={() => onReview(c.id)}>Mark reviewed</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
