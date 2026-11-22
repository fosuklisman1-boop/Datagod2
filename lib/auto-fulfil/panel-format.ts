import {
  AUTO_FULFIL_NETWORKS,
  DEFAULT_AUTO_FULFIL_SETTINGS,
  parseAutoFulfilSettings,
  type AutoFulfilSettings,
  type RetryBucket,
} from "./settings"

/** The seven retry buckets in table order. */
export const RETRY_BUCKETS = Object.keys(DEFAULT_AUTO_FULFIL_SETTINGS.rules) as RetryBucket[]

/** The settings form's editable state: number fields stay strings so the admin can clear a box while typing. */
export type SettingsDraft = {
  minAgeMinutes: string
  maxAgeDays: string
  perRun: string
  networks: string[]
  rules: Record<RetryBucket, { retry: boolean; waitMinutes: string; maxTries: string }>
}

/** A fresh draft; never shares objects with `settings`. */
export function settingsToDraft(settings: AutoFulfilSettings): SettingsDraft {
  const s = structuredClone(settings)
  const rules = {} as SettingsDraft["rules"]
  for (const b of RETRY_BUCKETS) {
    const r = s.rules[b] ?? DEFAULT_AUTO_FULFIL_SETTINGS.rules[b]
    rules[b] = { retry: r.retry, waitMinutes: String(r.waitMinutes), maxTries: String(r.maxTries) }
  }
  return {
    minAgeMinutes: String(s.minAgeMinutes),
    maxAgeDays: String(s.maxAgeDays),
    perRun: String(s.perRun),
    networks: s.networks,
    rules,
  }
}

const num = (v: string) => (v.trim() === "" ? NaN : Number(v))

/** The full settings object to PUT, checked with the server's own parser so bad input is caught before sending. */
export function draftToSettings(
  draft: SettingsDraft,
  enabled: boolean,
): { ok: true; value: AutoFulfilSettings } | { ok: false; error: string } {
  const rules: Record<string, unknown> = {}
  for (const b of RETRY_BUCKETS) {
    const r = draft.rules[b]
    rules[b] = { retry: r.retry, waitMinutes: num(r.waitMinutes), maxTries: num(r.maxTries) }
  }
  return parseAutoFulfilSettings({
    enabled,
    minAgeMinutes: num(draft.minAgeMinutes),
    maxAgeDays: num(draft.maxAgeDays),
    perRun: num(draft.perRun),
    networks: [...draft.networks],
    rules,
  })
}

/** The latest run as GET /api/admin/auto-fulfil returns it (counts only). */
export type PanelLastRun = {
  startedAt: string | null
  finishedAt: string | null
  queued: number | null | undefined
  waiting: number | null | undefined
  needsYou: number | null | undefined
  error: string | null
}

/** switches from GET /api/admin/auto-fulfil. nonMtn.enabled is the effective state (false when it covers no network). */
export type PanelSwitches = { mtn: boolean; nonMtn: { enabled: boolean; networks: string[] } }

function ago(iso: string | null, now: Date): string {
  const t = iso ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(t)) return "at an unknown time"
  const min = Math.floor(Math.max(0, now.getTime() - t) / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.floor(min / 60)} h ago`
  return `${Math.floor(min / 1440)} d ago`
}

export function describeLastRun(lastRun: PanelLastRun | null, now: Date): string {
  if (!lastRun) return "Never run"
  if (lastRun.error) return "Last run failed"
  if (!lastRun.finishedAt) return `Run in progress (started ${ago(lastRun.startedAt, now)})`
  const n = (v: number | null | undefined) => (typeof v === "number" ? v : 0)
  return `Last run ${ago(lastRun.finishedAt, now)} · ${n(lastRun.queued)} queued · ${n(lastRun.waiting)} waiting · ${n(lastRun.needsYou)} needs you`
}

/** Why each network will be skipped by the run; empty when every network will be worked. */
export function networkSkipNotes(settings: AutoFulfilSettings, switches: PanelSwitches): string[] {
  const notes: string[] = []
  for (const net of AUTO_FULFIL_NETWORKS) {
    if (!settings.networks.includes(net)) {
      notes.push(`${net} skipped: not in the auto-fulfilment networks`)
      continue
    }
    const on = net === "MTN" ? switches.mtn : switches.nonMtn.enabled && switches.nonMtn.networks.includes(net)
    if (!on) notes.push(`${net} skipped: ${net} auto-fulfilment is off`)
  }
  return notes
}
