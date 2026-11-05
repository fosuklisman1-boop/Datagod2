"use client"

import { useState } from "react"
import { DRAWER_PAGE_SIZE } from "@/lib/admin-users/drawer-params"
import { userApiPath } from "@/lib/admin-users/drawer-client"
import { LoadState, Pager, dateTime, useAdminGet } from "./shared"
import type { AuditRow, Paged } from "./types"

const ACTION_LABELS: Record<string, string> = {
  wallet_credit: "Wallet credited",
  wallet_debit: "Wallet debited",
  user_suspend: "Suspended",
  user_unsuspend: "Unsuspended",
  user_force_logout: "Signed out of all devices",
  user_password_reset_sent: "Password reset email sent",
  user_phone_verified: "Phone marked verified",
  user_phone_unverified: "Phone marked unverified",
  pricing_mode_set: "Pricing mode changed",
  custom_price_set: "Custom price set",
  custom_price_removed: "Custom price removed",
  user_role_change: "Role changed",
  user_notify: "Notification sent",
  user_note_create: "Note added",
  user_note_update: "Note edited",
  user_note_delete: "Note deleted",
  user_tags_change: "Tags changed",
  user_removed: "Account deleted",
}

/** One line summarising an audit row's change. */
export function auditSummary(r: Pick<AuditRow, "action" | "old_value" | "new_value">): string {
  const o = r.old_value ?? {}
  const n = r.new_value ?? {}
  const money = (v: unknown) => `GHS ${Number(v ?? 0).toFixed(2)}`
  switch (r.action) {
    case "wallet_credit":
    case "wallet_debit":
      return `${money(n.amount)}: ${money(o.balance)} → ${money(n.balance)}${n.reason ? ` · ${n.reason}` : ""}`
    case "user_suspend":
      return n.reason ? `Reason: ${n.reason}` : "No reason given"
    case "user_force_logout":
      return `${Number(n.sessions_revoked ?? 0)} session(s) revoked`
    case "user_password_reset_sent":
      return n.email ? `To ${n.email}` : ""
    case "pricing_mode_set":
      return `${o.pricing_mode ?? "?"} → ${n.pricing_mode ?? "?"}`
    case "custom_price_set":
      return `${o.price != null ? `${money(o.price)} → ` : ""}${money(n.price)}`
    case "custom_price_removed":
      return `was ${money(o.price)}`
    case "user_role_change":
      return `${o.role ?? "?"} → ${n.role ?? "?"}`
    case "user_notify":
      return `${n.title ?? ""}${Array.isArray(n.channels) ? ` (${(n.channels as string[]).join(", ")})` : ""}`
    case "user_note_create":
    case "user_note_update":
      return String(n.body ?? "").slice(0, 140)
    case "user_note_delete":
      return String(o.body ?? "").slice(0, 140)
    case "user_tags_change": {
      const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : [])
      return [list(n.added).map((t) => `+${t}`), list(n.removed).map((t) => `-${t}`)].flat().join(" ")
    }
    default:
      return ""
  }
}

/** admin_audit_log rows targeting this user, newest first. */
export function HistoryTab({ userId, refreshKey = 0 }: { userId: string; refreshKey?: number }) {
  const [page, setPage] = useState(1)
  const { data, error, loading, reload } = useAdminGet<Paged<AuditRow>>(
    userApiPath(userId, "audit", { page, pageSize: DRAWER_PAGE_SIZE }),
    refreshKey,
  )
  return (
    <LoadState loading={loading && !data} error={error} onRetry={reload}
      empty={data && data.rows.length === 0 ? "No admin actions recorded for this user" : undefined}>
      <ul className={`divide-y border rounded-lg ${loading ? "opacity-60" : ""}`}>
        {data?.rows.map((r) => (
          <li key={r.id} className="px-3 py-2 text-sm">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{ACTION_LABELS[r.action] ?? r.action}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">{dateTime(r.created_at)}</span>
            </div>
            <p className="text-xs text-muted-foreground break-words">{auditSummary(r)}</p>
            <p className="text-xs text-muted-foreground">by {r.admin_email ?? r.admin_id ?? "system (no signed-in admin)"}</p>
          </li>
        ))}
      </ul>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} loading={loading} onPage={setPage} />}
    </LoadState>
  )
}
