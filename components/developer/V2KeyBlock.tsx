// components/developer/V2KeyBlock.tsx
"use client"

import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import type { Environment, KeyType } from "@/lib/api-v2/keys"
import { slotFor, type SlotState, type V2KeySummary } from "@/lib/api-v2/key-slots"

export const slotId = (type: KeyType, env: Environment) => `${type}:${env}`

const PILL: Record<SlotState, { label: string; cls: string; dot: string }> = {
  pending: {
    label: "Waiting for approval",
    cls: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  active: {
    label: "Active",
    cls: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  revoked: { label: "Revoked", cls: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground/60" },
  none: { label: "No key yet", cls: "border-dashed border-border bg-transparent text-muted-foreground", dot: "bg-muted-foreground/40" },
}

export function StatusPill({ state }: { state: SlotState }) {
  const p = PILL[state]
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold", p.cls)}>
      <span className={cn("size-1.5 rounded-full", p.dot)} aria-hidden />
      {p.label}
    </span>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "Unknown"
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

function Confirm({
  trigger, title, body, action, destructive, onConfirm,
}: {
  trigger: React.ReactNode; title: string; body: React.ReactNode; action: string; destructive?: boolean; onConfirm: () => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm leading-6 text-muted-foreground">{body}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(destructive && "bg-destructive text-white hover:bg-destructive/90")}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export interface SlotHandlers {
  canGenerate: boolean
  /** Slot whose request is in flight, e.g. "standard:live"; every button is disabled while any request runs. */
  busySlot: string | null
  onGenerate: (type: KeyType, env: Environment) => void
  onRevoke: (key: V2KeySummary) => void
}

function KeySlot({ type, env, keys, h }: { type: KeyType; env: Environment; keys: V2KeySummary[]; h: SlotHandlers }) {
  const { state, key } = slotFor(keys, type, env)
  const usable = state === "pending" || state === "active"
  const busy = h.busySlot === slotId(type, env)
  const locked = h.busySlot !== null
  const envLabel = env === "live" ? "Live" : "Test"
  const spin = <Loader2 className="size-3.5 animate-spin" aria-hidden />

  return (
    <div className="min-w-0 space-y-3 rounded-xl border border-border/70 bg-background/60 p-3.5 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em]",
            env === "live" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
          )}>{envLabel}</span>
          <span className="text-xs text-muted-foreground">{env === "live" ? "Real orders and money" : "Sandbox, no real money"}</span>
        </div>
        <StatusPill state={state} />
      </div>

      {key ? (
        <div className="space-y-1.5">
          <p className="truncate rounded-lg border border-border/70 bg-muted/50 px-3 py-2 font-mono text-[13px] text-foreground" title="Only the prefix is stored in readable form">
            {key.key_prefix}<span className="text-muted-foreground">••••••••••••</span>
          </p>
          <dl className="grid grid-cols-2 gap-x-3 text-xs">
            <div className="min-w-0"><dt className="text-muted-foreground">Created</dt><dd className="truncate font-medium text-foreground">{formatDate(key.created_at)}</dd></div>
            <div className="min-w-0"><dt className="text-muted-foreground">Last used</dt><dd className="truncate font-medium text-foreground">{formatDate(key.last_used_at)}</dd></div>
          </dl>
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          {!h.canGenerate
            ? `No ${envLabel.toLowerCase()} key.`
            : env === "live"
              ? "Generate a live key when your integration is ready. It waits for admin approval before it works."
              : "Generate a test key to start building right away. It works immediately in the sandbox."}
        </p>
      )}

      {state === "pending" && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          This key cannot make requests yet. An admin will review and approve it; the status changes to Active once approved.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {h.canGenerate && !usable && (
          <Button size="sm" disabled={locked} onClick={() => h.onGenerate(type, env)} className="h-9 rounded-lg">
            {busy ? spin : <Plus className="size-3.5" aria-hidden />} Generate {envLabel.toLowerCase()} key
          </Button>
        )}
        {h.canGenerate && usable && (
          <Confirm
            trigger={<Button size="sm" variant="outline" disabled={locked} className="h-9 rounded-lg">{busy ? spin : <RefreshCw className="size-3.5" aria-hidden />} Regenerate</Button>}
            title={`Regenerate your ${envLabel.toLowerCase()} key?`}
            body={env === "live" ? (
              <>
                <p>Your current live key stops working <strong className="text-foreground">immediately</strong>.</p>
                <p>The new live key starts as <strong className="text-foreground">Waiting for approval</strong> and cannot make live requests until an admin approves it again. Your live integration will be down until then.</p>
              </>
            ) : (
              <p>Your current test key stops working immediately. The new test key is active straight away; update your app with it.</p>
            )}
            action="Regenerate key"
            onConfirm={() => h.onGenerate(type, env)}
          />
        )}
        {usable && key && (
          <Confirm
            trigger={<Button size="sm" variant="ghost" disabled={locked} className="h-9 rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"><Trash2 className="size-3.5" aria-hidden /> Revoke</Button>}
            title={`Revoke this ${envLabel.toLowerCase()} key?`}
            body={<p>Any app using <span className="font-mono text-foreground">{key.key_prefix}…</span> stops working immediately. Revoking cannot be undone; you can generate a new key afterwards.</p>}
            action="Revoke key"
            destructive
            onConfirm={() => h.onRevoke(key)}
          />
        )}
      </div>
    </div>
  )
}

export interface KeyTypeMeta { type: KeyType; title: string; description: string; prefix: string; icon: React.ElementType }

/** One key type (Standard / Commission) with its Test and Live slots. */
export function V2KeyBlock({ meta, keys, h }: { meta: KeyTypeMeta; keys: V2KeySummary[]; h: SlotHandlers }) {
  return (
    <section aria-label={`${meta.title} keys`} className="min-w-0 space-y-4 rounded-2xl border border-white/60 bg-card p-4 clay dark:border-white/5 sm:p-5">
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><meta.icon className="size-5" aria-hidden /></span>
        <div className="min-w-0">
          <h3 className="text-base font-bold text-foreground">{meta.title}</h3>
          <p className="text-xs leading-5 text-muted-foreground">{meta.description}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Starts with <code className="rounded bg-muted px-1 py-0.5 font-mono">{meta.prefix}</code></p>
        </div>
      </header>
      <div className="space-y-3">
        <KeySlot type={meta.type} env="test" keys={keys} h={h} />
        <KeySlot type={meta.type} env="live" keys={keys} h={h} />
      </div>
    </section>
  )
}
