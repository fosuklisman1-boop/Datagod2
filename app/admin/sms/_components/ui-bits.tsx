"use client"
import { useEffect, useId, useState, type ReactNode } from "react"
import { Check, Copy, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { pageInfo, parseList, statusLabel, statusTone, toneClass } from "../_lib/view"

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge variant="outline" className={toneClass(statusTone(status))}>{label ?? statusLabel(status)}</Badge>
}

export function CopyButton({ value, title = "Copy" }: { value: string; title?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button" title={title} aria-label={title}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200) }
        catch { toast.error("Couldn't copy") }
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="clay-inset rounded-2xl px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
      <span>{message}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
    </div>
  )
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}</div>
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { pages, from, to } = pageInfo(page, pageSize, total)
  if (total === 0) return null
  return (
    <div className="flex items-center justify-between gap-3 pt-2 text-sm text-muted-foreground">
      <span>{from}–{to} of {total}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  )
}

/** Confirmation dialog; with `reasonLabel` it also collects a required reason (min length enforced). */
export function ConfirmDialog(props: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode
  confirmLabel: string; destructive?: boolean; busy?: boolean
  reasonLabel?: string; minReason?: number; children?: ReactNode
  onConfirm: (reason: string) => void | Promise<void>
}) {
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const reasonId = useId()
  useEffect(() => { if (!props.open) setReason("") }, [props.open])
  const min = props.minReason ?? 3
  const needsReason = !!props.reasonLabel
  const invalid = needsReason && reason.trim().length < min
  const busy = !!props.busy || submitting
  async function confirm() {
    if (busy) return
    setSubmitting(true)
    try { await props.onConfirm(reason.trim()) } finally { setSubmitting(false) }
  }
  return (
    <Dialog open={props.open} onOpenChange={(o) => { if (!busy) { props.onOpenChange(o); if (!o) setReason("") } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription asChild><div>{props.description}</div></DialogDescription>}
        </DialogHeader>
        {props.children}
        {needsReason && (
          <div className="space-y-1.5">
            <label htmlFor={reasonId} className="text-sm font-medium">{props.reasonLabel}</label>
            <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
            {invalid && reason.length > 0 && <p className="text-xs text-red-600">At least {min} characters.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button variant={props.destructive ? "destructive" : "default"} disabled={busy || invalid} onClick={() => void confirm()}>
            {busy && <Loader2 className="size-4 animate-spin" />}{props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Chip list editor: type or paste comma/newline separated values; Backspace-free removal via ×. */
export function ChipsInput({ value, onChange, placeholder, transform }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; transform?: (s: string) => string
}) {
  const [text, setText] = useState("")
  function addText(raw: string) {
    const incoming = parseList(raw).map((s) => (transform ? transform(s) : s)).filter((s) => s.length > 0)
    if (incoming.length === 0) { setText(""); return }
    const seen = new Set(value.map((v) => v.toLowerCase()))
    const next = [...value]
    for (const i of incoming) if (!seen.has(i.toLowerCase())) { seen.add(i.toLowerCase()); next.push(i) }
    onChange(next); setText("")
  }
  const add = () => addText(text)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 && <span className="text-sm text-muted-foreground">None</span>}
        {value.map((v) => (
          <Badge key={v.toLowerCase()} variant="secondary" className="gap-1 font-mono">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}><X className="size-3" /></button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { e.preventDefault(); addText(`${text},${e.clipboardData.getData("text")}`) }}
          onBlur={() => { if (text.trim()) add() }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add() } }} />
        <Button type="button" variant="outline" onClick={add}>Add</Button>
      </div>
    </div>
  )
}
