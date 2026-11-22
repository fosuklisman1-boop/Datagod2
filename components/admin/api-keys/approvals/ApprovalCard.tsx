"use client"

import { useState } from "react"
import { Check, Loader2, ShieldAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { rejectReasonOk } from "@/lib/api-v2/console-tabs"
import type { ApprovalItem } from "@/lib/api-v2/approvals"

const KIND_LABEL: Record<ApprovalItem["kind"], string> = { key: "New live key", swap: "Key swap", access: "API access" }
const TYPE_LABEL: Record<string, string> = { standard: "Standard", commission: "Commission", sms: "SMS" }

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}
const money = (n: number) => `GHS ${n.toFixed(2)}`

/** Screen E (design 5E): one request with the context an admin needs before deciding. */
export function ApprovalCard({
  item,
  busy,
  onDecide,
}: {
  item: ApprovalItem
  busy: boolean
  onDecide: (action: "approve" | "reject", reason?: string) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState("")
  const o = item.owner

  return (
    <article className="min-w-0 space-y-3 rounded-xl border border-border bg-background/60 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="select-all font-mono text-sm font-bold text-foreground">{item.code || "(no code)"}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", item.kind === "access" ? "bg-violet-500/10 text-violet-700 dark:text-violet-300" : "bg-primary/10 text-primary")}>
            {KIND_LABEL[item.kind]}
            {item.keyType ? ` · ${TYPE_LABEL[item.keyType] ?? item.keyType}` : ""}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{ago(item.createdAt)}</span>
      </header>

      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">Name</dt><dd className="truncate font-medium">{o.name}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">Email</dt><dd className="truncate">{o.email ?? "-"}</dd></div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Registered phone</dt>
          <dd className="truncate font-mono">{o.phone ?? "-"}{o.phoneVerified ? " ✓" : ""}</dd>
        </div>
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">Role</dt><dd className="truncate">{o.role || "-"}{o.eligible ? "" : " (not allowed: approving gives API access only)"}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">Account age</dt><dd>{o.accountCreatedAt ? ago(o.accountCreatedAt).replace(" ago", "") : "-"}</dd></div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Wallet / top-ups / orders (30 days)</dt>
          <dd>{item.context ? `${money(item.context.balance)} · ${money(item.context.topups30d)} · ${item.context.orders30d}` : "-"}</dd>
        </div>
      </dl>

      {(o.suspended || (o.samePhoneAccounts ?? 0) >= 3) && (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
          <ShieldAlert className="size-3.5" aria-hidden />
          {o.suspended ? "Account suspended." : `${o.samePhoneAccounts} accounts share this phone.`}
        </p>
      )}

      <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-800 dark:text-amber-300">
        Match the code AND check the WhatsApp sender is the registered phone.
      </p>

      {rejecting ? (
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-foreground" htmlFor={`reason-${item.id}`}>Reason (shown to the developer)</label>
          <textarea
            id={`reason-${item.id}`}
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            className="min-h-16 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" className="h-9 rounded-lg" disabled={busy || !rejectReasonOk(reason)} onClick={() => onDecide("reject", reason.trim())}>
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />} Reject
            </Button>
            <Button size="sm" variant="ghost" className="h-9 rounded-lg" disabled={busy} onClick={() => setRejecting(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="h-9 rounded-lg" disabled={busy || o.suspended} onClick={() => onDecide("approve")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />} Approve
          </Button>
          <Button size="sm" variant="outline" className="h-9 rounded-lg" disabled={busy} onClick={() => setRejecting(true)}>
            <X className="size-3.5" aria-hidden /> Reject
          </Button>
        </div>
      )}
    </article>
  )
}
