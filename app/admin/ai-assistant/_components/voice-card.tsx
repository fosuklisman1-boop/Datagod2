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
  }
}

const AUDIENCE_ROWS: { key: VoiceAudience; title: string }[] = [
  { key: "public", title: "Public visitors" },
  { key: "storefront", title: "Shop visitors" },
  { key: "dashboard", title: "Signed-in users & shop owners" },
  { key: "admin", title: "Admins" },
]

interface Usage { callsToday: { total: number }; creditsLeft: number | null; renewsAt: string | null }

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
      </CardContent>
    </Card>
  )
}
