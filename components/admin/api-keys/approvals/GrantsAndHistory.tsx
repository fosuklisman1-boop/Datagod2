"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { rejectReasonOk } from "@/lib/api-v2/console-tabs"
import { adminFetch } from "../admin-fetch"
import { Eyebrow, InlineError, Panel } from "../ui"

interface Grant { userId: string; name: string; email: string | null; role: string; grantedAt: string }
interface HistoryRow { id: string; action: string; target_user_id: string | null; new_value: Record<string, unknown> | null; created_at: string }

const ACTION_LABEL: Record<string, string> = {
  api_key_approve: "Key approved",
  api_key_reject: "Key rejected",
  api_access_approve: "Access approved",
  api_access_reject: "Access rejected",
  api_grant_remove: "Access removed",
  api_key_revoke: "Key revoked",
  api_key_limits: "Limits changed",
  api_config: "Settings changed",
  api_global_kill: "Global kill",
}
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })

/** People with an API-only grant, with Remove (reason required). */
export function GrantsList() {
  const [items, setItems] = useState<Grant[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [reason, setReason] = useState("")

  const load = useCallback(async () => {
    const r = await adminFetch<{ items: Grant[] }>("/api/admin/api-v2/grants")
    if (r.ok && r.data) {
      setItems(r.data.items)
      setError(null)
    } else setError(r.error ?? "Could not load grants")
  }, [])
  useEffect(() => { void load() }, [load])

  const remove = async (userId: string) => {
    const r = await adminFetch(`/api/admin/api-v2/grants/${encodeURIComponent(userId)}`, { method: "DELETE", body: JSON.stringify({ reason: reason.trim() }) })
    if (r.ok) toast.success("Access removed")
    else toast.error(r.error ?? "Could not remove access")
    setRemoving(null)
    setReason("")
    await load()
  }

  return (
    <Panel className="space-y-3">
      <Eyebrow>Granted access</Eyebrow>
      {error ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : !items ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody has an API-only grant.</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((g) => (
            <li key={g.userId} className="space-y-2 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{g.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{g.email ?? "-"} · {g.role} · since {when(g.grantedAt)}</p>
                </div>
                {removing !== g.userId && (
                  <Button size="sm" variant="ghost" className="h-8 rounded-lg text-destructive" onClick={() => { setRemoving(g.userId); setReason("") }}>Remove</Button>
                )}
              </div>
              {removing === g.userId && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shown to the developer)" aria-label="Reason for removing access" className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm" />
                  <Button size="sm" variant="destructive" className="h-9 rounded-lg" disabled={!rejectReasonOk(reason)} onClick={() => void remove(g.userId)}>Remove access</Button>
                  <Button size="sm" variant="ghost" className="h-9 rounded-lg" onClick={() => setRemoving(null)}>Cancel</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** The api_* audit trail, newest first. */
export function HistoryList() {
  const [items, setItems] = useState<HistoryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    const r = await adminFetch<{ items: HistoryRow[] }>("/api/admin/api-v2/approvals/history")
    if (r.ok && r.data) {
      setItems(r.data.items)
      setError(null)
    } else setError(r.error ?? "Could not load history")
  }, [])
  useEffect(() => { void load() }, [load])

  return (
    <Panel className="space-y-3">
      <Eyebrow>History</Eyebrow>
      {error ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : !items ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API admin actions yet.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {items.map((h) => {
            const code = typeof h.new_value?.request_code === "string" ? h.new_value.request_code : null
            const reason = typeof h.new_value?.reason === "string" ? h.new_value.reason : null
            return (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs text-muted-foreground">{when(h.created_at)}</span>
                <span className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</span>
                {code && <span className="font-mono text-xs">{code}</span>}
                {reason && <span className="min-w-0 break-words text-xs text-muted-foreground">“{reason}”</span>}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
