"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Activity, BellRing, Wallet } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Eyebrow, IconChip, InlineError, Panel } from "@/components/admin/api-keys/ui"
import { StatusBoard } from "@/components/developer/StatusBoard"
import { ghs, usageTotals, type DayPoint } from "@/lib/api-v2/dev-dashboard-view"
import { parseThreshold } from "@/lib/api-v2/dev-dashboard"
import { DayBars } from "./DayBars"
import { dashJson } from "./dash-fetch"

export interface Usage {
  days: number
  daily: DayPoint[]
  endpoints: { endpoint: string; total: number; failed: number }[]
  reasons: { reason: string; count: number }[]
  orders: Record<string, number>
}

interface AlertState {
  alert: { threshold: number; armed: boolean; last_sent_at: string | null } | null
  balance: number | null
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3 dark:bg-white/[0.03]">
      <Eyebrow>{label}</Eyebrow>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function BalanceAlertCard() {
  const [state, setState] = useState<AlertState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const r = await dashJson<AlertState>("/api/user/v2-dashboard/balance-alert")
    if (!r.ok) return setError(r.error)
    setError(null)
    setState(r.data)
    setDraft(r.data.alert ? String(r.data.alert.threshold) : "")
  }, [])
  useEffect(() => void load(), [load])

  const save = async (value: string | null) => {
    const parsed = parseThreshold(value)
    if (!parsed.ok) return toast.error(parsed.error)
    setSaving(true)
    const r = await dashJson<Record<string, unknown>>("/api/user/v2-dashboard/balance-alert", { method: "PUT", body: { threshold: parsed.value } })
    setSaving(false)
    if (!r.ok) return toast.error(r.error)
    toast.success(parsed.value === null ? "Low-balance alert removed" : `We'll tell you when your balance drops below ${ghs(parsed.value)}`)
    await load()
  }

  return (
    <Panel className="space-y-4">
      <div className="flex items-start gap-3">
        <IconChip icon={Wallet} />
        <div className="min-w-0 flex-1">
          <Eyebrow>Wallet balance</Eyebrow>
          <p className="text-2xl font-bold tabular-nums">{state ? ghs(state.balance) : "…"}</p>
          <p className="text-xs text-muted-foreground">API purchases are paid from this wallet.</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard/wallet">Top up</Link>
        </Button>
      </div>
      {error && <InlineError message={error} onRetry={load} />}
      <div className="space-y-2 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <BellRing className="size-4 text-primary" aria-hidden />
          <p className="text-sm font-semibold">Low-balance alert</p>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          We send one notice (in the app, push and email) when your balance drops below this amount, and again only after it
          has gone back above it.
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void save(draft)
          }}
        >
          <label htmlFor="balance-alert" className="sr-only">Alert amount in GHS</label>
          <div className="flex items-center rounded-xl border border-input bg-background pl-3 focus-within:ring-2 focus-within:ring-ring">
            <span className="text-sm text-muted-foreground">GHS</span>
            <Input id="balance-alert" inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. 50"
              className="w-28 border-0 shadow-none focus-visible:ring-0" disabled={saving || !state} />
          </div>
          <Button type="submit" size="sm" disabled={saving || !state || !draft.trim()}>Save</Button>
          {state?.alert && (
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void save(null)}>Remove</Button>
          )}
        </form>
        {state?.alert && (
          <p className="text-xs text-muted-foreground">
            On at {ghs(state.alert.threshold)}.{" "}
            {state.alert.armed ? "Watching your balance." : "Already sent for this drop; it re-arms once your balance is back above it."}
          </p>
        )}
      </div>
    </Panel>
  )
}

export function OverviewTab({ onOpenTab }: { onOpenTab: (tab: "usage" | "logs" | "orders") => void }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    const r = await dashJson<Usage>("/api/user/v2-dashboard/usage?days=7")
    if (!r.ok) return setError(r.error)
    setError(null)
    setUsage(r.data)
  }, [])
  useEffect(() => void load(), [load])

  const today = usage?.daily[usage.daily.length - 1]
  const week = usageTotals(usage?.daily ?? [])
  const orders = Object.values(usage?.orders ?? {}).reduce((s, n) => s + Number(n), 0)

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="space-y-4">
        <BalanceAlertCard />
        <StatusBoard />
      </div>
      <Panel className="space-y-4">
        <div className="flex items-start gap-3">
          <IconChip icon={Activity} />
          <div className="min-w-0 flex-1">
            <Eyebrow>Last 7 days</Eyebrow>
            <p className="text-sm text-muted-foreground">Requests from all your keys (live and test).</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onOpenTab("usage")}>Details</Button>
        </div>
        {error && <InlineError message={error} onRetry={load} />}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Today" value={today ? String(today.ok + today.failed) : "…"} hint="requests" />
          <Tile label="Failed today" value={today ? String(today.failed) : "…"} hint={today?.failed ? "see Logs" : undefined} />
          <Tile label="Success, 7 days" value={week.successRate === null ? "-" : `${week.successRate}%`} hint={`${week.total} requests`} />
          <Tile label="Live orders, 7 days" value={usage ? String(orders) : "…"} />
        </div>
        {usage && <DayBars points={usage.daily} />}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onOpenTab("logs")}>Request logs</Button>
          <Button size="sm" variant="outline" onClick={() => onOpenTab("orders")}>Find an order</Button>
        </div>
      </Panel>
    </div>
  )
}
