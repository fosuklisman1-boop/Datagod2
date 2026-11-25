"use client"

// Release 5 admin money protection: the Overview card (two switches + risk thresholds) and the developer profile's
// daily limit, spend today and recent alerts. Browser-safe: only types come from the server libs.
import { useCallback, useEffect, useState } from "react"
import { Loader2, ShieldAlert } from "lucide-react"
import type { ThresholdKey } from "@/lib/api-v2/admin-console/money"
import { formatGhanaDate } from "@/lib/api-v1/retirement-ui"
import { cn } from "@/lib/utils"
import { adminFetch } from "./admin-fetch"
import { ConfirmAction } from "./ConfirmAction"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"

const ghs = (n: number) => `GHS ${n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface MoneySettingsView {
  capsEnabled: boolean
  alertsEnabled: boolean
  thresholds: Partial<Record<ThresholdKey, number>>
  alertsToday: number
  updatedAt: string | null
}
type Notice = { kind: "ok" | "error"; text: string } | null
type Which = "caps" | "alerts"

export const THRESHOLD_FIELDS: { key: ThresholdKey; label: string; step: string }[] = [
  { key: "spike_multiplier", label: "Spend spike: times the 7-day daily average", step: "0.1" },
  { key: "spike_min_ghs", label: "Spend spike: at least (GHS)", step: "0.01" },
  { key: "new_key_hours", label: "New key: younger than (hours)", step: "1" },
  { key: "new_key_min_ghs", label: "New key: spent more than (GHS)", step: "0.01" },
  { key: "fanout_recipients", label: "Many recipients: more than", step: "1" },
  { key: "fanout_minutes", label: "Many recipients: within (minutes)", step: "1" },
  { key: "cap_hits", label: "Limit refusals: at least", step: "1" },
  { key: "cap_hits_minutes", label: "Limit refusals: within (minutes)", step: "1" },
  { key: "failure_min_orders", label: "Failure burst: at least (purchases)", step: "1" },
  { key: "failure_ratio", label: "Failure burst: failed share above (0 to 1)", step: "0.05" },
  { key: "failure_minutes", label: "Failure burst: within (minutes)", step: "1" },
]

export const SIGNAL_LABEL: Record<string, string> = {
  spend_spike: "Spend spike",
  new_key_big_spend: "New key, big spend",
  recipient_fanout: "Many recipients",
  cap_hits: "Repeated limit refusals",
  failure_burst: "Failure burst",
}

/** What the confirm dialog says before a switch flips: what changes for developers (and admins). */
export function switchConfirmCopy(which: Which, next: boolean): { title: string; body: string; confirm: string } {
  if (which === "caps") {
    return next
      ? {
          title: "Switch daily spending limits on?",
          body: "Daily limits set by developers and by Datagod start to apply within a few seconds. A purchase that would go over a limit is refused with 402 DAILY_LIMIT_REACHED and nothing is charged. Keys without a limit work as before.",
          confirm: "Switch on",
        }
      : {
          title: "Switch daily spending limits off?",
          body: "Purchases are no longer checked against any daily limit. The limits stay saved and apply again when you switch back on.",
          confirm: "Switch off",
        }
  }
  return next
    ? {
        title: "Switch fraud warnings on?",
        body: "The risk scan checks live keys every 5 minutes and sends admins a WhatsApp and email for each new alert. Developers see nothing and nothing is blocked: pausing stays your decision.",
        confirm: "Switch on",
      }
    : { title: "Switch fraud warnings off?", body: "The risk scan stops: no new alerts are raised or sent.", confirm: "Switch off" }
}

function OnOff({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] font-bold",
        on ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border text-muted-foreground",
      )}
    >
      {on ? "On" : "Off"}
    </span>
  )
}

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null
  return (
    <p role={notice.kind === "error" ? "alert" : "status"} className={cn("text-xs font-semibold", notice.kind === "error" ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300")}>
      {notice.text}
    </p>
  )
}

function SwitchRow(p: { which: Which; title: string; hint: string; on: boolean; busy: boolean; onToggle: (which: Which, next: boolean) => Promise<boolean> }) {
  const copy = switchConfirmCopy(p.which, !p.on)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-foreground">{p.title}</p>
          <OnOff on={p.on} />
        </div>
        <p className="text-xs text-muted-foreground">{p.hint}</p>
      </div>
      <ConfirmAction
        trigger={
          <button type="button" disabled={p.busy} className="h-9 rounded-xl border border-border px-3 text-sm font-semibold disabled:opacity-60">
            {p.on ? "Switch off" : "Switch on"}
          </button>
        }
        title={copy.title}
        description={<p>{copy.body}</p>}
        confirmLabel={copy.confirm}
        onConfirm={() => p.onToggle(p.which, !p.on)}
      />
    </div>
  )
}

export function MoneyProtectionCardView(p: {
  settings: MoneySettingsView | null
  loading: boolean
  error: string | null
  notice: Notice
  busy: boolean
  onToggle: (which: Which, next: boolean) => Promise<boolean>
  onSaveThresholds: (t: Partial<Record<ThresholdKey, number>>) => Promise<boolean>
  onRetry: () => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const s = p.settings
  const valueOf = (k: ThresholdKey) => draft[k] ?? (s?.thresholds[k] != null ? String(s.thresholds[k]) : "")
  const save = () => {
    const out: Partial<Record<ThresholdKey, number>> = {}
    for (const f of THRESHOLD_FIELDS) if (draft[f.key] !== undefined && draft[f.key].trim() !== "") out[f.key] = Number(draft[f.key])
    void p.onSaveThresholds(out).then((ok) => ok && setDraft({}))
  }
  return (
    <Panel className="space-y-4">
      <div className="flex items-start gap-3">
        <IconChip icon={ShieldAlert} tone="amber" />
        <div>
          <Eyebrow>Release 5</Eyebrow>
          <h3 className="text-base font-bold text-foreground">Money protection</h3>
          {s && <p className="text-xs text-muted-foreground">{s.alertsToday === 1 ? "1 alert today" : `${s.alertsToday} alerts today`}</p>}
        </div>
      </div>
      {p.loading && !s ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading</p>
      ) : p.error && !s ? (
        <InlineError message={p.error} onRetry={p.onRetry} />
      ) : s ? (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <SwitchRow which="caps" title="Daily spending limits" hint="Refuse purchases over a developer's or Datagod's daily limit." on={s.capsEnabled} busy={p.busy} onToggle={p.onToggle} />
            <SwitchRow which="alerts" title="Fraud warnings" hint="Scan live keys every 5 minutes and warn admins." on={s.alertsEnabled} busy={p.busy} onToggle={p.onToggle} />
          </div>
          <details className="rounded-xl border border-border p-3">
            <summary className="cursor-pointer text-sm font-semibold text-foreground">Warning thresholds</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {THRESHOLD_FIELDS.map((f) => (
                <label key={f.key} className="space-y-1 text-xs">
                  <span className="block font-medium text-foreground">{f.label}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={f.step}
                    value={valueOf(f.key)}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
                  />
                </label>
              ))}
            </div>
            <button type="button" disabled={p.busy} onClick={save} className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60">
              {p.busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Save thresholds
            </button>
          </details>
        </>
      ) : null}
      <NoticeLine notice={p.notice} />
    </Panel>
  )
}

/** Overview card: loads the settings, flips a switch (after its confirm) and saves thresholds. */
export function MoneyProtectionCard() {
  const [settings, setSettings] = useState<MoneySettingsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const load = useCallback(async () => {
    setLoading(true)
    const r = await adminFetch<MoneySettingsView>("/api/admin/api-v2/money-settings", { cache: "no-store" })
    if (r.ok && r.data) setSettings(r.data)
    setError(r.ok ? null : r.error)
    setLoading(false)
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const put = async (body: Record<string, unknown>, ok: string) => {
    if (busy) return false
    setBusy(true)
    setNotice(null)
    const r = await adminFetch("/api/admin/api-v2/money-settings", { method: "PUT", body: JSON.stringify(body) })
    setBusy(false)
    setNotice(r.ok ? { kind: "ok", text: ok } : { kind: "error", text: r.error ?? "Could not save." })
    await load()
    return r.ok
  }
  return (
    <MoneyProtectionCardView
      settings={settings}
      loading={loading}
      error={error}
      notice={notice}
      busy={busy}
      onToggle={(which, next) =>
        put(which === "caps" ? { capsEnabled: next } : { alertsEnabled: next }, `${which === "caps" ? "Daily spending limits" : "Fraud warnings"} switched ${next ? "on" : "off"}.`)
      }
      onSaveThresholds={(t) => put({ thresholds: t }, "Thresholds saved.")}
      onRetry={() => void load()}
    />
  )
}

// ---------------- developer profile: Datagod limit, spend today, alerts ----------------

export interface DeveloperSpendView {
  today: number
  userCap: number | null
  keys: { keyId: string; spent: number; cap: number | null }[]
  refusalsToday: number
  alerts: { signal: string; createdAt: string | null; details: Record<string, number> }[]
}

export function DeveloperMoneyView(p: {
  spend: DeveloperSpendView | null
  keyLabels: Record<string, string>
  capsEnabled: boolean
  value: string
  busy: boolean
  loading: boolean
  error: string | null
  notice: Notice
  onChange: (v: string) => void
  onSave: () => void
  onRetry: () => void
}) {
  const s = p.spend
  return (
    <Panel className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Eyebrow>Money protection</Eyebrow>
          <h3 className="text-base font-bold text-foreground">Daily spending</h3>
        </div>
        {!p.capsEnabled && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-bold text-muted-foreground">Not active yet</span>}
      </div>
      {p.loading && !s ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading</p>
      ) : !s ? (
        p.error ? <InlineError message={p.error} onRetry={p.onRetry} /> : null
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              Spent today: {ghs(s.today)} · Refused today: <span className="font-bold">{s.refusalsToday}</span> · resets at 00:00 GMT
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-sm">
                <span className="block font-medium text-foreground">Datagod limit (GHS)</span>
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
              <button type="button" disabled={p.busy} onClick={p.onSave} className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60">
                {p.busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Save
              </button>
            </div>
            <p className="text-xs text-muted-foreground">Empty means no Datagod limit. The developer only sees that a Datagod limit applies, never the amount.</p>
            <ul className="space-y-1 text-sm">
              {s.keys.map((k) => (
                <li key={k.keyId} className="flex flex-wrap justify-between gap-2 rounded-lg border border-border px-3 py-2">
                  <span className="break-all font-mono text-xs">{p.keyLabels[k.keyId] ?? "live key"}</span>
                  <span className="text-xs">
                    {ghs(k.spent)} of {k.cap === null ? "No limit" : ghs(k.cap)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground">Recent alerts</p>
            {s.alerts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No alerts.</p>
            ) : (
              <ul className="space-y-1">
                {s.alerts.map((a, i) => (
                  <li key={i} className="rounded-lg border border-border px-3 py-2 text-xs">
                    <span className="font-semibold text-foreground">{SIGNAL_LABEL[a.signal] ?? "Alert"}</span>
                    {a.createdAt && Number.isFinite(Date.parse(a.createdAt)) && <span className="text-muted-foreground"> · {formatGhanaDate(new Date(a.createdAt))}</span>}
                    {Object.keys(a.details).length > 0 && (
                      <span className="block text-muted-foreground">{Object.entries(a.details).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {s && p.error && <p role="alert" className="text-xs font-semibold text-rose-700 dark:text-rose-300">{p.error}</p>}
      <NoticeLine notice={p.notice} />
    </Panel>
  )
}

/** Profile panel: loads spend + the caps switch, saves the Datagod (per-person) limit. */
export function DeveloperMoneyPanel({ userId, keyLabels }: { userId: string; keyLabels: Record<string, string> }) {
  const url = `/api/admin/api-v2/developers/${encodeURIComponent(userId)}/spend-cap`
  const [spend, setSpend] = useState<DeveloperSpendView | null>(null)
  const [capsEnabled, setCapsEnabled] = useState(false)
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const load = useCallback(async () => {
    setLoading(true)
    const [r, m] = await Promise.all([
      adminFetch<DeveloperSpendView>(url, { cache: "no-store" }),
      adminFetch<{ capsEnabled?: boolean }>("/api/admin/api-v2/money-settings", { cache: "no-store" }),
    ])
    if (r.ok && r.data) {
      setSpend(r.data)
      setValue(r.data.userCap === null ? "" : String(r.data.userCap))
    }
    setCapsEnabled(m.ok && m.data?.capsEnabled === true)
    setError(r.ok ? null : r.error)
    setLoading(false)
  }, [url])
  useEffect(() => {
    void load()
  }, [load])
  const save = async () => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    setError(null)
    const r = await adminFetch(url, { method: "PUT", body: JSON.stringify({ cap: value.trim() === "" ? null : value.trim() }) })
    setBusy(false)
    if (!r.ok) setError(r.error)
    else setNotice({ kind: "ok", text: value.trim() === "" ? "Datagod limit removed." : "Datagod limit saved." })
    await load()
  }
  return (
    <DeveloperMoneyView
      spend={spend}
      keyLabels={keyLabels}
      capsEnabled={capsEnabled}
      value={value}
      busy={busy}
      loading={loading}
      error={error}
      notice={notice}
      onChange={setValue}
      onSave={() => void save()}
      onRetry={() => void load()}
    />
  )
}
