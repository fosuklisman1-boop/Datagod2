"use client"

import { useCallback, useEffect, useState } from "react"
import { Activity, Loader2, PauseCircle, PlayCircle } from "lucide-react"
import type { ServiceState, PublicStatus } from "@/lib/api-v2/status-public"
import type { ServiceControlRow } from "@/lib/api-v2/admin-console/services"
import { SERVICE_MESSAGE_MAX, serviceMessageOk, servicePauseCopy } from "@/lib/api-v2/admin-console/console-forms"
import { cn } from "@/lib/utils"
import { adminFetch } from "./admin-fetch"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"

export interface ServiceCardData {
  id: string
  title: string
  paused: boolean
  message: string | null
  missing: boolean
  state: ServiceState
  successRate24h: number | null
}

const STATE_LABEL: Record<ServiceState, { label: string; tone: string }> = {
  operational: { label: "Operational", tone: "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300" },
  degraded: { label: "Degraded", tone: "border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300" },
  paused: { label: "Paused", tone: "border-rose-500/40 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300" },
  no_data: { label: "Not enough traffic", tone: "border-border bg-muted/50 text-muted-foreground" },
}

/** The confirm step for a service pause or resume. Pausing takes an optional public message (max 200, plain text). */
export function ServicePauseForm(p: { title: string; pausing: boolean; message: string; busy: boolean; onMessage: (v: string) => void; onSubmit: () => void; onCancel: () => void }) {
  const copy = servicePauseCopy(p.title, p.pausing)
  const len = Array.from(p.message.trim()).length
  const canSubmit = !p.busy && (!p.pausing || serviceMessageOk(p.message))
  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-3">
      <p className="text-sm font-semibold text-foreground">{copy.title}</p>
      <p className="text-sm text-muted-foreground">{copy.body}</p>
      {p.pausing && (
        <label className="block space-y-1 text-sm">
          <span className="flex justify-between gap-2 font-medium text-foreground">
            <span>Public message (optional, plain text)</span>
            <span className={cn("tabular-nums", len > SERVICE_MESSAGE_MAX ? "text-rose-600" : "text-muted-foreground")}>
              {len}/{SERVICE_MESSAGE_MAX}
            </span>
          </span>
          <textarea value={p.message} onChange={(e) => p.onMessage(e.target.value)} rows={2} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={p.onSubmit}
          className={cn("inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-60", p.pausing ? "bg-rose-600 hover:bg-rose-700" : "bg-primary hover:bg-primary/90")}
        >
          {p.busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {copy.confirm}
        </button>
        <button type="button" disabled={p.busy} onClick={p.onCancel} className="h-9 rounded-xl border border-border px-4 text-sm font-semibold">
          Cancel
        </button>
      </div>
    </div>
  )
}

function ServiceCard({ s, busy, onSave }: { s: ServiceCardData; busy: boolean; onSave: (paused: boolean, message: string | null) => Promise<boolean> }) {
  const [confirming, setConfirming] = useState<null | boolean>(null)
  const [message, setMessage] = useState("")
  const st = STATE_LABEL[s.state]
  return (
    <li className="space-y-3 rounded-2xl border border-border bg-card p-4 dark:bg-white/[0.03]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-foreground">{s.title}</p>
          <p className="text-sm text-muted-foreground">
            {s.successRate24h === null ? "Not enough traffic in 24 h for a rate" : `${s.successRate24h}% success in the last 24 h`}
          </p>
        </div>
        <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-bold", st.tone)}>{st.label}</span>
      </div>
      {s.missing && <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">This service has no control row yet (treated as not paused).</p>}
      {s.paused && s.message && <p className="whitespace-pre-line break-words rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground">{s.message}</p>}
      {confirming === null ? (
        <button
          type="button"
          onClick={() => {
            setMessage(s.message ?? "")
            setConfirming(!s.paused)
          }}
          className={cn("inline-flex h-9 items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold", s.paused ? "border-primary/40 text-primary" : "border-rose-500/50 text-rose-600 dark:text-rose-400")}
        >
          {s.paused ? <PlayCircle className="size-4" aria-hidden /> : <PauseCircle className="size-4" aria-hidden />}
          {s.paused ? "Resume service" : "Pause service"}
        </button>
      ) : (
        <ServicePauseForm
          title={s.title}
          pausing={confirming}
          message={message}
          busy={busy}
          onMessage={setMessage}
          onCancel={() => setConfirming(null)}
          onSubmit={async () => {
            const ok = await onSave(confirming, confirming && message.trim() ? message.trim() : null)
            if (ok) setConfirming(null)
          }}
        />
      )}
    </li>
  )
}

export function ServicesTabView(p: {
  services: ServiceCardData[]
  loading: boolean
  error: string | null
  notice: { kind: "ok" | "error"; text: string } | null
  busyId: string | null
  onSave: (id: string, paused: boolean, message: string | null) => Promise<boolean>
  onRetry: () => void
}) {
  return (
    <Panel className="space-y-4">
      <div className="flex items-start gap-3">
        <IconChip icon={Activity} />
        <div className="min-w-0 flex-1">
          <Eyebrow>API v2</Eyebrow>
          <h2 className="text-base font-bold text-foreground">Services and status</h2>
          <p className="text-sm text-muted-foreground">
            Pause one service for every developer. Pauses revoke nothing and take effect within a few seconds. Developers see the state on the public status page.
          </p>
        </div>
      </div>
      {p.notice &&
        (p.notice.kind === "error" ? (
          <InlineError message={p.notice.text} />
        ) : (
          <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{p.notice.text}</p>
        ))}
      {p.error ? (
        <InlineError message={p.error} onRetry={p.onRetry} />
      ) : p.loading && p.services.length === 0 ? (
        <div className="h-40 animate-pulse rounded-xl bg-muted" aria-label="Loading services" />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {p.services.map((s) => (
            <ServiceCard key={s.id} s={s} busy={p.busyId === s.id} onSave={(paused, message) => p.onSave(s.id, paused, message)} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Merges the admin controls (pause state, message) with the public status (24 h rate and state). */
export function mergeServices(controls: ServiceControlRow[], status: PublicStatus | null): ServiceCardData[] {
  return controls.map((c) => {
    const pub = status?.services.find((s) => s.id === c.id)
    const state: ServiceState = c.paused ? "paused" : pub && pub.state !== "paused" ? pub.state : "no_data"
    return { id: c.id, title: c.title, paused: c.paused, message: c.message, missing: c.missing, state, successRate24h: pub?.successRate24h ?? null }
  })
}

export function ServicesTab() {
  const [controls, setControls] = useState<ServiceControlRow[]>([])
  const [status, setStatus] = useState<PublicStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [c, s] = await Promise.all([
      adminFetch<{ services?: ServiceControlRow[] }>("/api/admin/api-v2/services"),
      fetch("/api/developers/status").then((r) => (r.ok ? (r.json() as Promise<PublicStatus>) : null)).catch(() => null),
    ])
    setControls(c.ok ? (c.data?.services ?? []) : [])
    setError(c.ok ? null : c.error)
    setStatus(s)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onSave = async (id: string, paused: boolean, message: string | null) => {
    if (busyId) return false
    setBusyId(id)
    setNotice(null)
    const r = await adminFetch(`/api/admin/api-v2/services/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ paused, message }) })
    setBusyId(null)
    if (!r.ok) {
      setNotice({ kind: "error", text: r.error ?? "Could not save." })
      return false
    }
    setNotice({ kind: "ok", text: paused ? "Paused. New purchases and sends stop within a few seconds." : "Resumed. Purchases and sends work again within a few seconds." })
    await load()
    return true
  }

  return <ServicesTabView services={mergeServices(controls, status)} loading={loading} error={error} notice={notice} busyId={busyId} onSave={onSave} onRetry={() => void load()} />
}
