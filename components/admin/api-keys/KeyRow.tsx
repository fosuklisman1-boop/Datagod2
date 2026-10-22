"use client"

import { useState } from "react"
import { Activity, BarChart3, Check, ChevronDown, FlaskConical, Loader2, SlidersHorizontal } from "lucide-react"
import { formatDistanceToNowStrict } from "date-fns"
import { cn } from "@/lib/utils"
import { formatCount, keyActions, keyTypeLabel, roleLabel, type ConsoleKey } from "@/lib/api-v2/admin-view"
import type { KeyActivity } from "@/lib/api-v2/admin-stats"
import type { LimitGroup } from "@/lib/api-v2/limits"
import { StatusBadge } from "./ui"
import { ConfirmAction } from "./ConfirmAction"
import { ActivityPanel } from "./ActivityPanel"
import { LimitsEditor } from "./LimitsEditor"
import { V1Controls } from "./V1Controls"

export interface KeyRowHandlers {
  approve: (k: ConsoleKey) => Promise<boolean>
  revoke: (k: ConsoleKey) => Promise<boolean>
  saveLimits: (k: ConsoleKey, limits: Record<LimitGroup, number>) => Promise<boolean>
  resetLimits: (k: ConsoleKey) => Promise<boolean>
  v1Toggle: (k: ConsoleKey) => Promise<boolean>
  v1Delete: (k: ConsoleKey) => Promise<boolean>
  v1SetRate: (k: ConsoleKey, perMin: number) => Promise<boolean>
}

const TYPE_CLS: Record<string, string> = {
  Standard: "border-primary/30 bg-primary/[0.07] text-primary",
  "Commission · Utilities": "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  SMS: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  v1: "border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300",
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?"

const iconBtn =
  "inline-flex h-9 items-center justify-center gap-1 rounded-lg border border-border bg-background px-2.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-expanded:border-primary/40 aria-expanded:bg-primary/[0.07] aria-expanded:text-primary dark:bg-transparent"

export function KeyRow({
  k,
  busy,
  handlers,
  initialOpen,
  activityPreset,
}: {
  k: ConsoleKey
  busy: boolean
  handlers: KeyRowHandlers
  initialOpen?: { activity?: boolean; limits?: boolean }
  activityPreset?: KeyActivity
}) {
  const [showActivity, setShowActivity] = useState(!!initialOpen?.activity)
  const [showLimits, setShowLimits] = useState(!!initialOpen?.limits)
  const can = keyActions(k)
  const type = keyTypeLabel(k)
  // v2 owners resolve to "Deleted user"; the v1 route substitutes "Deleted User" / "Unknown".
  const deleted = /^deleted user$/i.test(k.ownerName)
  const statusLabel = k.source === "v1" && k.status === "revoked" ? "Disabled" : undefined

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm dark:bg-white/[0.03]">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold",
            deleted ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary dark:bg-primary/20"
          )}
          aria-hidden
        >
          {initials(k.ownerName)}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("truncate font-semibold", deleted ? "italic text-muted-foreground" : "text-foreground")}>{k.ownerName}</p>
          {k.ownerEmail && !deleted && <p className="truncate text-sm text-muted-foreground" title={k.ownerEmail}>{k.ownerEmail}</p>}
          <p className="mt-1 truncate font-mono text-xs text-foreground/70" title="Key prefix (the full key is never stored)">
            {k.prefix}
            <span className="tracking-tight text-muted-foreground/70">●●●●●●●●</span>
          </p>
        </div>
        <StatusBadge status={k.status} label={statusLabel} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <span className={cn("rounded-md border px-2 py-0.5 font-semibold", TYPE_CLS[type])}>{type}</span>
        {k.environment === "test" && (
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-700 dark:text-amber-300">
            <FlaskConical className="size-3" aria-hidden />
            Test
          </span>
        )}
        <span className="text-muted-foreground">{roleLabel(k.ownerRole)}</span>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5" title={k.requests24h === null ? "Request count unavailable" : undefined}>
          <Activity className="size-3.5 text-primary" aria-hidden />
          <span className="font-semibold tabular-nums text-foreground">{formatCount(k.requests24h)}</span> req/24h
        </span>
        <span className="truncate">
          {k.lastUsedAt ? `Used ${formatDistanceToNowStrict(new Date(k.lastUsedAt))} ago` : "Never used"}
        </span>
      </div>

      {k.source === "v1" ? (
        <V1Controls k={k} busy={busy} onToggle={() => handlers.v1Toggle(k)} onDelete={() => handlers.v1Delete(k)} onSetRate={(n) => handlers.v1SetRate(k, n)} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {can.approve && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlers.approve(k)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
              Approve
            </button>
          )}
          {can.revoke && (
            <ConfirmAction
              trigger={
                <button
                  type="button"
                  disabled={busy}
                  className="inline-flex h-9 items-center rounded-lg border border-rose-500/50 px-3.5 text-sm font-semibold text-rose-600 transition-colors hover:bg-rose-500/10 disabled:opacity-60 dark:text-rose-400"
                >
                  Revoke
                </button>
              }
              title="Revoke this API key?"
              description={
                <>
                  <p>
                    <span className="font-mono">{k.prefix}…</span> owned by {k.ownerName} stops working immediately.
                  </p>
                  <p>Revoking cannot be undone; the owner has to generate a new key and wait for approval.</p>
                </>
              }
              confirmLabel="Revoke key"
              onConfirm={() => handlers.revoke(k)}
            />
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" aria-expanded={showActivity} aria-label="User activity" onClick={() => setShowActivity((v) => !v)} className={iconBtn}>
              <BarChart3 className="size-4" aria-hidden />
              <ChevronDown className={cn("size-3.5 transition-transform", showActivity && "rotate-180")} aria-hidden />
            </button>
            {can.limits && (
              <button type="button" aria-expanded={showLimits} aria-label="Per-key rate limits" onClick={() => setShowLimits((v) => !v)} className={iconBtn}>
                <SlidersHorizontal className="size-4" aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}

      {can.activity && showActivity && <ActivityPanel keyId={k.id} preset={activityPreset} />}
      {can.limits && showLimits && (
        <LimitsEditor k={k} busy={busy} onSave={(l) => handlers.saveLimits(k, l)} onReset={() => handlers.resetLimits(k)} />
      )}
    </article>
  )
}
