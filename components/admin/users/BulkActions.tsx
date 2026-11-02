"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Bell, ChevronDown, Loader2, ShieldOff, ShieldCheck, UserCog } from "lucide-react"
import { toast } from "sonner"
import { adminJson } from "@/lib/admin-users/drawer-client"
import { BROADCAST_LIMITS } from "@/lib/broadcast-limits"
import {
  BULK_MAX_USERS, BULK_ROLES, NOTIFY_CHANNELS, NOTIFY_MATCHING_MAX, SUSPEND_REASON_MAX, SUSPEND_REASON_MIN,
  bulkConfirmTitle, summariseBulkResults,
  type BulkAction, type BulkResultRow, type BulkRole, type NotifyChannel,
} from "@/lib/admin-users/bulk-params"
import type { UsersListFilters } from "@/lib/admin-users/list-params"

const CHANNEL_LABELS: Record<NotifyChannel, string> = { in_app: "In-app (and mobile app push)", push: "Web push", sms: "SMS" }
const ROLE_LABELS: Record<BulkRole, string> = { user: "User", dealer: "Dealer", admin: "Admin" }

interface BulkResponse {
  action: BulkAction
  total: number
  succeeded: number
  failed: number
  results: BulkResultRow[]
  broadcastId?: string | null
}

export interface BulkActionsProps {
  selectedIds: ReadonlySet<string>
  /** Every user matching the current filters is targeted (notifications only). */
  allMatching: boolean
  onAllMatchingChange: (on: boolean) => void
  /** Users matching the current filters. */
  total: number
  filters: UsersListFilters
  onClear: () => void
  /** A bulk action finished (reload the list). */
  onDone: () => void
  /** Email for an id, when the page has seen that user. */
  labelOf: (id: string) => string
}

/** The bar shown while users are selected, and the confirm / result dialog of each bulk action. */
export function BulkActions({ selectedIds, allMatching, onAllMatchingChange, total, filters, onClear, onDone, labelOf }: BulkActionsProps) {
  const [pending, setPending] = useState<{ action: BulkAction; role?: BulkRole } | null>(null)
  const count = allMatching ? total : selectedIds.size
  if (count === 0 && !allMatching) return null

  const tooMany = !allMatching && selectedIds.size > BULK_MAX_USERS
  const explicitBlocked = allMatching || tooMany
  const blockedWhy = allMatching
    ? "Role and suspension changes need users selected one by one (at most 200)"
    : tooMany ? `Select at most ${BULK_MAX_USERS} users for role and suspension changes` : undefined
  const notifyBlocked = !allMatching && selectedIds.size > BULK_MAX_USERS
    ? `Select at most ${BULK_MAX_USERS} users, or select all matching users`
    : allMatching && total > NOTIFY_MATCHING_MAX ? `At most ${NOTIFY_MATCHING_MAX.toLocaleString()} users; narrow the filters or use the Broadcast page` : undefined

  return (
    <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-sm sm:flex-row sm:flex-wrap sm:items-center" role="region" aria-label="Bulk actions">
      <span className="font-medium" aria-live="polite">
        {allMatching ? `All ${total.toLocaleString()} matching users` : `${selectedIds.size.toLocaleString()} selected`}
      </span>
      {!allMatching && total > selectedIds.size && (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onAllMatchingChange(true)}
          title="Every user matching the current filters, on every page. Only for notifications.">
          Select all {total.toLocaleString()} matching (notifications only)
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => { onAllMatchingChange(false); onClear() }}>Clear</Button>
      <div className="flex flex-wrap gap-2 sm:ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1" disabled={explicitBlocked} title={blockedWhy}>
              <UserCog className="w-4 h-4" /> Change role <ChevronDown className="w-3 h-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {BULK_ROLES.map((r) => (
              <DropdownMenuItem key={r} onSelect={() => setPending({ action: "set_role", role: r })}>{ROLE_LABELS[r]}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="outline" className="gap-1 text-destructive" disabled={explicitBlocked} title={blockedWhy}
          onClick={() => setPending({ action: "suspend" })}>
          <ShieldOff className="w-4 h-4" /> Suspend
        </Button>
        <Button size="sm" variant="outline" className="gap-1" disabled={explicitBlocked} title={blockedWhy}
          onClick={() => setPending({ action: "unsuspend" })}>
          <ShieldCheck className="w-4 h-4" /> Unsuspend
        </Button>
        <Button size="sm" variant="outline" className="gap-1" disabled={!!notifyBlocked} title={notifyBlocked}
          onClick={() => setPending({ action: "notify" })}>
          <Bell className="w-4 h-4" /> Notify
        </Button>
      </div>

      {pending && (
        <BulkDialog
          key={`${pending.action}:${pending.role ?? ""}`}
          action={pending.action}
          role={pending.role}
          count={count}
          target={allMatching ? { matching: filters } : { userIds: [...selectedIds] }}
          labelOf={labelOf}
          onClose={(changed) => {
            setPending(null)
            if (changed) onDone()
          }}
        />
      )}
    </div>
  )
}

function BulkDialog({ action, role, count, target, labelOf, onClose }: {
  action: BulkAction
  role?: BulkRole
  count: number
  target: { userIds: string[] } | { matching: UsersListFilters }
  labelOf: (id: string) => string
  onClose: (changed: boolean) => void
}) {
  const [reason, setReason] = useState("")
  const [title, setTitle] = useState("")
  const [message, setMessage] = useState("")
  const [channels, setChannels] = useState<NotifyChannel[]>(["in_app", "push"])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkResponse | null>(null)

  const params =
    action === "set_role" ? { role } :
    action === "notify" ? { title, message, channels } :
    { reason }
  const valid =
    action === "suspend" ? reason.trim().length >= SUSPEND_REASON_MIN && reason.trim().length <= SUSPEND_REASON_MAX :
    action === "unsuspend" ? reason.trim().length <= SUSPEND_REASON_MAX :
    action === "notify" ? !!title.trim() && !!message.trim() && channels.length > 0 : true

  const run = async () => {
    setBusy(true)
    try {
      const res = await adminJson<BulkResponse>("/api/admin/users/bulk", { method: "POST", body: { action, ...target, params } })
      setResult(res)
      if (res.failed === 0) toast.success(`Done: ${res.succeeded.toLocaleString()} of ${res.total.toLocaleString()}`)
      else toast.warning(`${res.failed.toLocaleString()} of ${res.total.toLocaleString()} failed`)
    } catch (e: any) {
      toast.error(e?.message || "Bulk action failed")
    } finally {
      setBusy(false)
    }
  }

  const summary = result ? summariseBulkResults(result.results) : null

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(!!result) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{result ? "Bulk action finished" : bulkConfirmTitle(action, count, role)}</DialogTitle>
          {!result && (
            <DialogDescription asChild>
              <div className="space-y-1 text-sm text-muted-foreground">
                {action === "set_role" && <>
                  <p>Each user gets the {ROLE_LABELS[role ?? "user"]} role and a push notification. Users who already have it are left as they are.</p>
                  {role === "dealer" && <p>Sub-agents (shops under a parent shop) cannot become dealers and are reported as failed. New dealers&apos; shop margins are raised so their selling prices stay the same.</p>}
                  <p>Your own account is skipped.</p>
                </>}
                {action === "suspend" && <p>Each user is signed out and blocked, and told by SMS, email and push (with the reason). Your own account is skipped.</p>}
                {action === "unsuspend" && <p>Each user can sign in again and is told by SMS, email and push. Your own account is skipped.</p>}
                {action === "notify" && <p>
                  Sent through the Broadcast page&apos;s queue: the first {BROADCAST_LIMITS.firstBatch} now, the rest within minutes. It appears in Broadcast history.
                  {"matching" in target && " Every user matching the current filters is included."}
                </p>}
              </div>
            </DialogDescription>
          )}
        </DialogHeader>

        {!result && (action === "suspend" || action === "unsuspend") && (
          <div className="space-y-1">
            <Label htmlFor="bulk-reason">Reason{action === "suspend" ? " (required, sent to the users)" : " (optional)"}</Label>
            <Textarea id="bulk-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={SUSPEND_REASON_MAX} rows={3} />
          </div>
        )}
        {!result && action === "notify" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="bulk-title">Title</Label>
              <Input id="bulk-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={BROADCAST_LIMITS.subjectMax} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-message">Message</Label>
              <Textarea id="bulk-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={BROADCAST_LIMITS.messageMax} rows={4} />
              <p className="text-xs text-muted-foreground text-right">{message.length}/{BROADCAST_LIMITS.messageMax}{channels.includes("sms") && message.length > 160 ? " · more than one SMS each" : ""}</p>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Channels</legend>
              {NOTIFY_CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={channels.includes(c)}
                    onCheckedChange={(on) => setChannels((cur) => (on === true ? [...cur, c] : cur.filter((x) => x !== c)))} />
                  {CHANNEL_LABELS[c]}
                </label>
              ))}
            </fieldset>
          </div>
        )}

        {result && summary && (
          <div className="space-y-2 text-sm">
            <p>
              <strong>{summary.succeeded.toLocaleString()}</strong> of {summary.total.toLocaleString()} succeeded
              {summary.unchanged > 0 && <> ({summary.unchanged.toLocaleString()} already as requested)</>}
              {summary.failed > 0 && <>, <strong className="text-destructive">{summary.failed.toLocaleString()} failed</strong></>}.
            </p>
            {summary.errors.length > 0 && (
              <ul className="max-h-60 overflow-y-auto space-y-2 rounded border p-2">
                {summary.errors.map((g) => (
                  <li key={g.error}>
                    <p className="font-medium text-destructive">{g.error} ({g.ids.length})</p>
                    <p className="text-xs text-muted-foreground break-all">{g.ids.slice(0, 20).map(labelOf).join(", ")}{g.ids.length > 20 ? ` and ${g.ids.length - 20} more` : ""}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onClose(true)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onClose(false)}>Cancel</Button>
              <Button variant={action === "suspend" ? "destructive" : "default"} disabled={busy || !valid} onClick={run}>
                {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {action === "notify" ? `Send to ${count.toLocaleString()}` : `${action === "set_role" ? "Change" : action === "suspend" ? "Suspend" : "Unsuspend"} ${count.toLocaleString()}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
