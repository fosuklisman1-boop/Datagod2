"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, ShieldCheck } from "lucide-react"
import { supabase } from "@/lib/supabase"
import type { V2KeySummary } from "@/lib/api-v2/key-slots"

const ghs = (n: number) => `GHS ${n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** One live key's daily limit. The admin's limit is never shown as a number: only that one applies. */
export function SpendCapView(p: {
  label: string
  spentToday: number
  cap: number | null
  adminLimitApplies: boolean
  active: boolean
  value: string
  busy: boolean
  error: string | null
  onChange: (v: string) => void
  onSave: () => void
}) {
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-all font-mono text-sm text-foreground">{p.label}</p>
        {!p.active && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-bold text-muted-foreground">Not active yet</span>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-foreground">Daily spending limit (GHS)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={p.value}
            onChange={(e) => p.onChange(e.target.value)}
            placeholder="No limit"
            className="h-10 w-40 rounded-lg border border-border bg-background px-3 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={p.busy}
          onClick={p.onSave}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {p.busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Save
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Spent today: {ghs(p.spentToday)} · {p.cap === null ? "No limit set (empty means no limit)" : `Your limit: ${ghs(p.cap)}`} · resets at 00:00 GMT
      </p>
      {p.adminLimitApplies && <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">A Datagod daily limit also applies.</p>}
      {p.error && (
        <p role="alert" className="text-xs font-semibold text-rose-700 dark:text-rose-300">
          {p.error}
        </p>
      )}
    </div>
  )
}

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

function KeyLimit({ k }: { k: V2KeySummary }) {
  const [state, setState] = useState<{ spentToday: number; cap: number | null; adminLimitApplies: boolean; active: boolean } | null>(null)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const url = `/api/user/v2-keys/${encodeURIComponent(k.id)}/spend-cap`

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { headers: await authHeader() })
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) return setError(typeof d.error === "string" ? d.error : "Could not load the limit")
      const cap = typeof d.cap === "number" ? d.cap : null
      setState({ spentToday: Number(d.spentToday) || 0, cap, adminLimitApplies: d.adminLimitApplies === true, active: d.active === true })
      setValue(cap === null ? "" : String(cap))
    } catch {
      setError("Could not load the limit")
    }
  }, [url])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ cap: value.trim() === "" ? null : value.trim() }),
      })
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) setError(typeof d.error === "string" ? d.error : "Could not save the limit")
      else await load()
    } catch {
      setError("Could not save the limit")
    } finally {
      setBusy(false)
    }
  }

  if (!state) return error ? <p className="text-xs text-rose-700">{error}</p> : null
  return (
    <SpendCapView
      label={`${k.key_type} live key ${k.key_prefix}`}
      spentToday={state.spentToday}
      cap={state.cap}
      adminLimitApplies={state.adminLimitApplies}
      active={state.active}
      value={value}
      busy={busy}
      error={error}
      onChange={setValue}
      onSave={() => void save()}
    />
  )
}

/** Daily spending limits for the developer's active live keys (protects their wallet if a key leaks). */
export function DailyLimits({ keys }: { keys: V2KeySummary[] }) {
  const live = keys.filter((k) => k.environment === "live" && k.status === "active")
  if (live.length === 0) return null
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 text-primary" aria-hidden />
        <div>
          <h3 className="text-sm font-bold text-foreground">Daily spending limits</h3>
          <p className="text-xs text-muted-foreground">
            A safety net if a key leaks: purchases over the limit are refused with 402 and nothing is charged. Limits count the value you buy.
          </p>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {live.map((k) => (
          <KeyLimit key={k.id} k={k} />
        ))}
      </div>
    </section>
  )
}
