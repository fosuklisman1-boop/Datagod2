"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { supabase } from "@/lib/supabase"
import type { VoiceAudience, VoiceSettings, VoicePersonaId } from "@/lib/ai-voice/settings"

/** Numeric fields are edited as text so half-typed values are allowed; parsed on save. */
export interface VoiceDraft {
  settings: VoiceSettings
  maxMinutes: string
  expressiveness: string
  dailyDashboard: string
  dailyPublic: string
  dailyStorefront: string
  visitorTotal: string
  callsPerKey: string
  queueMax: string
  queueMaxWaitMinutes: string
}

type TextKey = keyof Omit<VoiceDraft, "settings">

export function toVoiceDraft(s: VoiceSettings): VoiceDraft {
  return {
    settings: s,
    maxMinutes: String(Math.round(s.maxCallSeconds / 60)),
    expressiveness: String(s.expressiveness),
    dailyDashboard: String(s.dailyCalls.dashboard),
    dailyPublic: String(s.dailyCalls.public),
    dailyStorefront: String(s.dailyCalls.storefront),
    visitorTotal: String(s.visitorDailyTotal),
    callsPerKey: String(s.callsPerKey),
    queueMax: String(s.queueMax),
    queueMaxWaitMinutes: String(s.queueMaxWaitMinutes),
  }
}

const num = (t: string) => (t.trim() === "" ? NaN : Number(t))
const isInt = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max

export function voiceErrors(d: VoiceDraft): Partial<Record<TextKey, string>> {
  const e: Partial<Record<TextKey, string>> = {}
  if (!isInt(num(d.maxMinutes), 1, 30)) e.maxMinutes = "Whole minutes from 1 to 30."
  const x = num(d.expressiveness)
  if (!(Number.isFinite(x) && x >= 0 && x <= 2)) e.expressiveness = "A number from 0 to 2."
  for (const k of ["dailyDashboard", "dailyPublic", "dailyStorefront"] as const) {
    if (!isInt(num(d[k]), 0, 50)) e[k] = "Whole number from 0 to 50."
  }
  if (!isInt(num(d.visitorTotal), 0, 1000)) e.visitorTotal = "Whole number from 0 to 1000."
  if (!isInt(num(d.callsPerKey), 1, 20)) e.callsPerKey = "Whole number from 1 to 20."
  if (!isInt(num(d.queueMax), 1, 100)) e.queueMax = "Whole number from 1 to 100."
  if (!isInt(num(d.queueMaxWaitMinutes), 1, 60)) e.queueMaxWaitMinutes = "Whole minutes from 1 to 60."
  return e
}

/** Draft -> the settings object the API stores. Only call when voiceErrors is empty. */
export function voiceFromDraft(d: VoiceDraft): VoiceSettings {
  return {
    ...d.settings,
    maxCallSeconds: Math.round(num(d.maxMinutes)) * 60,
    expressiveness: num(d.expressiveness),
    dailyCalls: { dashboard: num(d.dailyDashboard), public: num(d.dailyPublic), storefront: num(d.dailyStorefront) },
    visitorDailyTotal: num(d.visitorTotal),
    callsPerKey: num(d.callsPerKey),
    queueMax: num(d.queueMax),
    queueMaxWaitMinutes: num(d.queueMaxWaitMinutes),
  }
}

const AUDIENCE_ROWS: { key: VoiceAudience; title: string }[] = [
  { key: "public", title: "Public visitors" },
  { key: "storefront", title: "Shop visitors" },
  { key: "dashboard", title: "Signed-in users & shop owners" },
  { key: "admin", title: "Admins" },
]

interface Usage { callsToday: { total: number }; creditsLeft: number | null; renewsAt: string | null; accounts?: number }

function renewTime(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
}

function UsageLine() {
  const [usage, setUsage] = useState<Usage | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const res = await fetch("/api/admin/ai-voice/usage", { headers: { Authorization: `Bearer ${session?.access_token}` } })
        if (!res.ok) throw new Error("usage")
        const j = (await res.json()) as Usage
        if (alive) setUsage(j)
      } catch {
        if (alive) setUsage(null)
      }
    }
    void run()
    return () => { alive = false }
  }, [])
  if (usage === undefined) return <p className="text-xs text-muted-foreground">Loading usage...</p>
  if (usage === null) return <p className="text-xs text-muted-foreground">Usage unavailable.</p>
  const t = renewTime(usage.renewsAt)
  return (
    <p className="text-xs text-muted-foreground">
      Calls today: {usage.callsToday.total} · Credits left: {usage.creditsLeft ?? "—"}
      {t ? ` (renews ${t})` : ""}
      {typeof usage.accounts === "number" ? ` · Nuance accounts set up: ${usage.accounts}` : ""}
    </p>
  )
}

function Pill({ on }: { on: boolean }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${on ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
      {on ? "On" : "Off"}
    </span>
  )
}

function NumField({ id, label, value, onChange, error, hint, step }: {
  id: string; label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string; step?: string
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
      <Input id={id} type="number" inputMode="decimal" step={step} value={value} onChange={(e) => onChange(e.target.value)} className="max-w-[12rem]" />
      <p className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{error ?? hint}</p>
    </div>
  )
}

export function VoiceCard({ draft, onChange }: { draft: VoiceDraft; onChange: (d: VoiceDraft) => void }) {
  const s = draft.settings
  const err = voiceErrors(draft)
  const setS = (patch: Partial<VoiceSettings>) => onChange({ ...draft, settings: { ...s, ...patch } })
  const setF = (patch: Partial<Omit<VoiceDraft, "settings">>) => onChange({ ...draft, ...patch })

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Voice &amp; video</CardTitle>
          <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">New</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Live voice and video calls with the assistant. Off by default; switch on only the groups you want.
        </p>
        <UsageLine />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-border p-3">
          <div className="min-w-0 flex-1">
            <Label htmlFor="voice-enabled" className="text-sm font-medium text-foreground">Voice &amp; video calls</Label>
            <p className="text-xs text-muted-foreground">Master switch. Off hides calling for everyone.</p>
          </div>
          <Pill on={s.enabled} />
          <Switch id="voice-enabled" checked={s.enabled} onCheckedChange={(v) => setS({ enabled: v })} />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ul className="divide-y divide-border rounded-xl border border-border">
            {AUDIENCE_ROWS.map((r) => (
              <li key={r.key} className="flex items-center gap-3 p-3">
                <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{r.title}</p>
                <Pill on={s.audiences[r.key]} />
                <Switch
                  aria-label={r.title}
                  checked={s.audiences[r.key]}
                  onCheckedChange={(v) => setS({ audiences: { ...s.audiences, [r.key]: v } })}
                />
              </li>
            ))}
          </ul>

          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="voice-persona" className="text-sm font-medium">Voice</Label>
              <select
                id="voice-persona"
                value={s.personaId}
                onChange={(e) => setS({ personaId: e.target.value as VoicePersonaId })}
                className="flex h-9 w-full max-w-[12rem] rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="sam">Sam</option>
                <option value="sonia">Sonia</option>
                <option value="mira">Mira</option>
              </select>
              <p className="text-xs text-muted-foreground">Try them in the Nuance Playground.</p>
            </div>
            <NumField id="voice-expr" label="Expressiveness" step="0.1" value={draft.expressiveness}
              onChange={(v) => setF({ expressiveness: v })} error={err.expressiveness} hint="0 is calm, 2 is very animated." />
            <NumField id="voice-minutes" label="Max call length (minutes)" value={draft.maxMinutes}
              onChange={(v) => setF({ maxMinutes: v })} error={err.maxMinutes} hint="1 to 30 minutes." />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumField id="voice-cap-dash" label="Calls per day, signed-in user" value={draft.dailyDashboard}
            onChange={(v) => setF({ dailyDashboard: v })} error={err.dailyDashboard} hint="0 to 50. Admins have no cap." />
          <NumField id="voice-cap-public" label="Calls per day, public visitor device" value={draft.dailyPublic}
            onChange={(v) => setF({ dailyPublic: v })} error={err.dailyPublic} hint="0 to 50." />
          <NumField id="voice-cap-shop" label="Calls per day, shop visitor device" value={draft.dailyStorefront}
            onChange={(v) => setF({ dailyStorefront: v })} error={err.dailyStorefront} hint="0 to 50." />
          <NumField id="voice-cap-total" label="Total visitor calls per day" value={draft.visitorTotal}
            onChange={(v) => setF({ visitorTotal: v })} error={err.visitorTotal} hint="0 to 1000, all visitors together." />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex items-center gap-3 rounded-xl border border-border p-3">
            <div className="min-w-0 flex-1">
              <Label htmlFor="voice-multi" className="text-sm font-medium text-foreground">Use multiple Nuance accounts</Label>
              <p className="text-xs text-muted-foreground">
                Beta only. When an account runs out of credits or its call slot is busy, the next call uses the next
                account (NUANCE_API_KEY_2, _3 ... in Vercel). Turn off when Nuance moves to paid plans: only the main
                key is used.
              </p>
            </div>
            <Pill on={s.multiAccount} />
            <Switch id="voice-multi" checked={s.multiAccount} onCheckedChange={(v) => setS({ multiAccount: v })} />
          </div>
          <NumField id="voice-per-key" label="Calls at once per Nuance account" value={draft.callsPerKey}
            onChange={(v) => setF({ callsPerKey: v })} error={err.callsPerKey} hint="1 to 20. Nuance's free beta allows 1." />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="flex items-center gap-3 rounded-xl border border-border p-3">
            <div className="min-w-0 flex-1">
              <Label htmlFor="voice-queue" className="text-sm font-medium text-foreground">Waiting line</Label>
              <p className="text-xs text-muted-foreground">
                When every call slot is taken, callers wait on the page and their call starts on their turn. Off shows
                &quot;busy&quot; instead. When the day&apos;s credits are gone there is no line: calls show as closed for today.
              </p>
            </div>
            <Pill on={s.queueEnabled} />
            <Switch id="voice-queue" checked={s.queueEnabled} onCheckedChange={(v) => setS({ queueEnabled: v })} />
          </div>
          <NumField id="voice-queue-max" label="Longest line" value={draft.queueMax}
            onChange={(v) => setF({ queueMax: v })} error={err.queueMax} hint="1 to 100 callers waiting at once. More are told the line is full." />
          <NumField id="voice-queue-wait" label="Longest wait shown (minutes)" value={draft.queueMaxWaitMinutes}
            onChange={(v) => setF({ queueMaxWaitMinutes: v })} error={err.queueMaxWaitMinutes} hint="1 to 60. A caller whose estimated wait is longer is told it is busy." />
        </div>
      </CardContent>
    </Card>
  )
}
