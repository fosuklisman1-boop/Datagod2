"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { toast } from "sonner"
import { HUBTEL_CS_SERVICES, HUBTEL_CS_SERVICE_KEYS } from "@/lib/hubtel-cs/services"
import {
  CASHBACK_GROUPS, SHARE_FIELDS, groupOf,
  type CashbackConfig, type CashbackGroup, type CashbackProvider, type GroupShares, type ShareField,
} from "@/lib/cashback/config"
import { quoteCashback } from "@/lib/cashback/quote"

export type Authed = (path: string, init?: RequestInit) => Promise<any>

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Request failed")
const gh = (n: number, dp = 2) => `GHS ${Number(n).toFixed(dp)}`
const GROUP_LABEL: Record<CashbackGroup, string> = { airtime: "Airtime", bundles: "Data bundles", bills: "Utility bills" }
const FIELD_LABEL: Record<ShareField, string> = {
  customer: "Customer %", dealer: "Dealer %", storefrontCustomer: "Storefront customer %", storefrontShop: "Storefront shop %",
}
const EXAMPLE_SERVICE: Record<CashbackGroup, string> = { airtime: "airtime_mtn", bundles: "data_mtn", bills: "bill_ecg" }
const EXAMPLE_FACE = 10
const MATCH_TOLERANCE = 0.05

const providersFor = (key: string): CashbackProvider[] => (key.startsWith("airtime_") ? ["hubtel", "digiwapy"] : ["hubtel"])
const RATE_ROWS: { key: string; provider: CashbackProvider; rateKey: string }[] = HUBTEL_CS_SERVICE_KEYS.flatMap(key =>
  providersFor(key).map(provider => ({ key, provider, rateKey: `${key}:${provider}` })),
)

/** Parse an input string to a number, or null when blank / not numeric. */
const num = (s: string): number | null => {
  const t = s.trim()
  if (t === "") return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export interface ReportRow {
  service_key: string; provider: string; orders: number; face_total: number
  actual_commission: number; cashback_total: number; shop_share_total: number; expected_commission: number
}

/** Actual rate % from Hubtel's recorded commission, 3 dp; null when there is no Hubtel data. */
export function actualRate(r: ReportRow): number | null {
  if (r.provider !== "hubtel" || !(r.face_total > 0) || !(r.actual_commission > 0)) return null
  return Math.round((r.actual_commission / r.face_total) * 100 * 1000) / 1000
}

export function rateStatus(set: number, actual: number | null): "ok" | "warn" | "none" {
  if (actual === null) return "none"
  if (set === 0) return "warn"
  return Math.abs(set - actual) <= MATCH_TOLERANCE ? "ok" : "warn"
}

const toStrings = (cfg: CashbackConfig) => ({
  rates: Object.fromEntries(RATE_ROWS.map(r => [r.rateKey, String(cfg.rates[r.rateKey] ?? 0)])) as Record<string, string>,
  shares: Object.fromEntries(CASHBACK_GROUPS.map(g => [g, Object.fromEntries(SHARE_FIELDS.map(f => [f, String(cfg.shares[g][f])]))])) as Record<CashbackGroup, Record<ShareField, string>>,
  overrides: Object.fromEntries(Object.entries(cfg.shares.overrides).map(([k, o]) => [k, Object.fromEntries(SHARE_FIELDS.map(f => [f, o[f] === undefined ? "" : String(o[f])]))])) as Record<string, Record<ShareField, string>>,
})

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export function CashbackSettingsCard({ authed, rateInputs }: {
  authed: Authed
  /** Shared with the report so "Use actual" can fill a rate input. */
  rateInputs: { values: Record<string, string>; set: (rateKey: string, v: string) => void; reset: (all: Record<string, string>) => void }
}) {
  const [cfg, setCfg] = useState<CashbackConfig | null>(null)
  const [shares, setShares] = useState<Record<CashbackGroup, Record<ShareField, string>> | null>(null)
  const [overrides, setOverrides] = useState<Record<string, Record<ShareField, string>>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const apply = useCallback((c: CashbackConfig) => {
    const s = toStrings(c)
    setCfg(c); setShares(s.shares); setOverrides(s.overrides); rateInputs.reset(s.rates)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const load = useCallback(async () => {
    try { apply((await authed("/api/admin/cashback/config")).config); setError(null) } catch (e) { setError(errMsg(e)) }
  }, [authed, apply])
  useEffect(() => { void load() }, [load])

  async function save(patch: object, okMsg = "Saved") {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    try { apply((await authed("/api/admin/cashback/config", { method: "POST", body: JSON.stringify(patch) })).config); toast.success(okMsg) }
    catch (e) { toast.error(errMsg(e)) } finally { inFlight.current = false; setBusy(false) }
  }

  function saveRates() {
    if (!cfg) return
    const changed: Record<string, number> = {}
    for (const r of RATE_ROWS) {
      const n = num(rateInputs.values[r.rateKey] ?? "")
      if (n === null) { toast.error(`Rate for ${HUBTEL_CS_SERVICES[r.key as keyof typeof HUBTEL_CS_SERVICES].label} (${r.provider}) is not a number`); return }
      if (n !== (cfg.rates[r.rateKey] ?? 0)) changed[r.rateKey] = n
    }
    if (Object.keys(changed).length === 0) { toast.info("No rate changes"); return }
    void save({ rates: changed }, "Rates saved")
  }

  function saveGroup(g: CashbackGroup) {
    if (!shares) return
    const out: Partial<GroupShares> = {}
    for (const f of SHARE_FIELDS) {
      const n = num(shares[g][f])
      if (n === null) { toast.error(`${GROUP_LABEL[g]}: ${FIELD_LABEL[f]} is not a number`); return }
      out[f] = n
    }
    void save({ shares: { [g]: out } }, `${GROUP_LABEL[g]} shares saved`)
  }

  function saveOverride(key: string) {
    const o = overrides[key]
    if (!o) return
    const out: Partial<GroupShares> = {}
    for (const f of SHARE_FIELDS) {
      const raw = o[f] ?? ""
      if (raw.trim() === "") continue
      const n = num(raw)
      if (n === null) { toast.error(`${FIELD_LABEL[f]} is not a number`); return }
      out[f] = n
    }
    if (Object.keys(out).length === 0) { toast.info("Enter at least one override value"); return }
    void save({ shares: { overrides: { [key]: out } } }, "Override saved")
  }

  // Live example: the draft inputs fed through the real quote maths, with the gates forced open so shares are visible.
  const example = useMemo(() => {
    if (!cfg || !shares) return null
    const draft: CashbackConfig = {
      enabled: true,
      surfaces: { dashboard: true, bots: true, storefront: true, api: true },
      rates: Object.fromEntries(RATE_ROWS.map(r => [r.rateKey, num(rateInputs.values[r.rateKey] ?? "") ?? 0])),
      shares: {
        ...Object.fromEntries(CASHBACK_GROUPS.map(g => [g, Object.fromEntries(SHARE_FIELDS.map(f => [f, num(shares[g][f]) ?? 0]))])),
        overrides: cfg.shares.overrides,
      } as CashbackConfig["shares"],
    }
    return Object.fromEntries(CASHBACK_GROUPS.map(g => {
      const serviceKey = EXAMPLE_SERVICE[g]
      const q = (buyer: "customer" | "dealer", channel: "dashboard" | "storefront") =>
        quoteCashback({ serviceKey, provider: "hubtel", faceAmount: EXAMPLE_FACE, buyer, channel }, draft)
      return [g, { serviceKey, customer: q("customer", "dashboard"), dealer: q("dealer", "dashboard"), storefront: q("customer", "storefront") }]
    })) as Record<CashbackGroup, { serviceKey: string; customer: ReturnType<typeof quoteCashback>; dealer: ReturnType<typeof quoteCashback>; storefront: ReturnType<typeof quoteCashback> }>
  }, [cfg, shares, rateInputs.values])

  if (error && !cfg) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900">
        Could not load Cashback settings: {error}
        <Button size="sm" variant="outline" className="ml-3" onClick={() => { void load() }}>Retry</Button>
      </div>
    )
  }
  if (!cfg || !shares) return <div className="rounded-xl border p-8 text-center text-muted-foreground">Loading cashback settings...</div>

  const surfaces: { key: keyof CashbackConfig["surfaces"]; label: string; live: boolean; note?: string }[] = [
    { key: "dashboard", label: "Dashboard", live: true },
    { key: "bots", label: "Bots", live: false, note: "Part 2/3 — not yet active" },
    { key: "storefront", label: "Storefront", live: false, note: "Part 2/3 — not yet active" },
    { key: "api", label: "API", live: false, note: "Part 2/3 — not yet active" },
  ]

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Instant cashback</CardTitle>
            <CardDescription>Customers pay less up front: a share of the provider commission is taken off the price. Ships OFF.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
              <div className="font-medium">Cashback enabled (master switch)</div>
              <Switch aria-label="Cashback master switch" checked={cfg.enabled} disabled={busy}
                onCheckedChange={v => save({ enabled: v }, v ? "Cashback enabled" : "Cashback disabled")} />
            </div>
            <div className="text-sm font-medium">Surfaces</div>
            {surfaces.map(s => (
              <div key={s.key} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <div>
                  <div className="font-medium">{s.label}</div>
                  {s.note && <div className="text-xs text-muted-foreground">{s.note}</div>}
                </div>
                <Switch aria-label={`${s.label} surface`} checked={cfg.surfaces[s.key]} disabled={busy || !s.live}
                  onCheckedChange={v => save({ surfaces: { [s.key]: v } }, `${s.label} ${v ? "on" : "off"}`)} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live example: GHS {EXAMPLE_FACE} purchase</CardTitle>
            <CardDescription>Uses the values in the inputs below (before saving). Hubtel rate shown for {Object.values(EXAMPLE_SERVICE).join(", ")}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {example && CASHBACK_GROUPS.map(g => {
              const e = example[g]
              const line = (label: string, q: typeof e.customer, shop?: boolean) => q.applied
                ? `${label} pays ${gh(q.payAmount)} (cashback ${gh(q.customerCashback)}${shop ? `, shop earns ${gh(q.shopShare)}` : ""})`
                : `${label} pays ${gh(q.payAmount)} (no cashback)`
              return (
                <div key={g} className="rounded-xl border p-3">
                  <div className="font-medium">{GROUP_LABEL[g]} <span className="font-mono text-xs text-muted-foreground">{e.serviceKey}</span></div>
                  <div>{line("Customer", e.customer)}</div>
                  <div>{line("Dealer", e.dealer)}</div>
                  <div>{line("Storefront customer", e.storefront, true)}</div>
                  {e.customer.applied && <div className="text-xs text-muted-foreground">Commission {gh(e.customer.commission, 4)}; Datagod keeps {gh(e.customer.datagodKeeps, 4)} on a customer order.</div>}
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Commission rates</CardTitle>
          <CardDescription>The percent of the face amount each provider pays us. Set these to match the real rates; the margin report below shows the rate Hubtel actually paid.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {RATE_ROWS.map(r => (
              <label key={r.rateKey} className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
                <span>
                  <span className="font-medium">{HUBTEL_CS_SERVICES[r.key as keyof typeof HUBTEL_CS_SERVICES].label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{r.provider}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Input aria-label={`${r.key} ${r.provider} rate percent`} className="w-24 text-right" inputMode="decimal"
                    value={rateInputs.values[r.rateKey] ?? ""} onChange={e => rateInputs.set(r.rateKey, e.target.value)} />
                  <span className="text-muted-foreground">%</span>
                </span>
              </label>
            ))}
          </div>
          <Button disabled={busy} onClick={saveRates}>Save rates</Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {CASHBACK_GROUPS.map(g => {
          const keys = HUBTEL_CS_SERVICE_KEYS.filter(k => groupOf(k) === g)
          return (
            <Card key={g}>
              <CardHeader>
                <CardTitle>{GROUP_LABEL[g]} shares</CardTitle>
                <CardDescription>Percent of the commission passed on. Storefront customer + shop must not exceed 100.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {SHARE_FIELDS.map(f => (
                    <label key={f} className="space-y-1 text-xs text-muted-foreground">
                      {FIELD_LABEL[f]}
                      <Input aria-label={`${g} ${FIELD_LABEL[f]}`} inputMode="decimal" value={shares[g][f]}
                        onChange={e => setShares(s => s && ({ ...s, [g]: { ...s[g], [f]: e.target.value } }))} />
                    </label>
                  ))}
                </div>
                <Button size="sm" disabled={busy} onClick={() => saveGroup(g)}>Save {GROUP_LABEL[g].toLowerCase()} shares</Button>
                <div className="space-y-2 border-t pt-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Per-service overrides</div>
                  {keys.map(k => {
                    const o = overrides[k] ?? Object.fromEntries(SHARE_FIELDS.map(f => [f, ""])) as Record<ShareField, string>
                    const hasOverride = !!cfg.shares.overrides[k]
                    return (
                      <div key={k} className="rounded-lg border">
                        <button type="button" className="flex w-full items-center justify-between p-2 text-left text-sm" aria-expanded={!!open[k]}
                          onClick={() => setOpen(s => ({ ...s, [k]: !s[k] }))}>
                          <span>{HUBTEL_CS_SERVICES[k].label}{hasOverride && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">override</span>}</span>
                          <span className="text-xs text-muted-foreground">{open[k] ? "Hide" : "Override"}</span>
                        </button>
                        {open[k] && (
                          <div className="space-y-2 border-t p-2">
                            <div className="grid grid-cols-2 gap-2">
                              {SHARE_FIELDS.map(f => (
                                <label key={f} className="space-y-1 text-xs text-muted-foreground">
                                  {FIELD_LABEL[f]}
                                  <Input aria-label={`${k} ${FIELD_LABEL[f]} override`} inputMode="decimal" placeholder="inherit" value={o[f]}
                                    onChange={e => setOverrides(s => ({ ...s, [k]: { ...o, [f]: e.target.value } }))} />
                                </label>
                              ))}
                            </div>
                            <div className="text-xs text-muted-foreground">Blank fields inherit the group value. An override can be changed but not removed here; set it equal to the group value to neutralise it.</div>
                            <Button size="sm" disabled={busy} onClick={() => saveOverride(k)}>Save override</Button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Margin report
// ---------------------------------------------------------------------------------------------

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export function CashbackReportCard({ authed, currentRates, onUseActual }: {
  authed: Authed
  /** Set rate % per "<service>:<provider>" as currently saved/typed. */
  currentRates: Record<string, string>
  onUseActual: (rateKey: string, rate: number) => void
}) {
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 7 * 86400000)))
  const [to, setTo] = useState(() => isoDay(new Date()))
  const [rows, setRows] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` })
      const j = await authed(`/api/admin/cashback/report?${params}`)
      if (id !== seq.current) return
      setRows(j.rows ?? []); setError(null)
    } catch (e) {
      if (id === seq.current) setError(errMsg(e))
    } finally { if (id === seq.current) setLoading(false) }
  }, [authed, from, to])
  useEffect(() => { void load() }, [load])

  const sorted = useMemo(() => [...rows].sort((a, b) => a.service_key.localeCompare(b.service_key) || a.provider.localeCompare(b.provider)), [rows])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Margin report</CardTitle>
        <CardDescription>Completed orders in the window. Actual rate = Hubtel commission recorded / face value. Digiwapy rows show the expected commission (not verified by the provider).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs text-muted-foreground">From
            <Input type="date" aria-label="Report from" value={from} max={to} onChange={e => setFrom(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">To
            <Input type="date" aria-label="Report to" value={to} min={from} onChange={e => setTo(e.target.value)} />
          </label>
          <Button variant="outline" disabled={loading} onClick={() => { void load() }}>{loading ? "Loading..." : "Refresh"}</Button>
        </div>
        {error && <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">Could not load report: {error}</div>}
        {!error && sorted.length === 0 && !loading && <div className="rounded-xl border p-6 text-center text-muted-foreground">No completed orders in this window.</div>}
        {sorted.length > 0 && (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="p-2">Service</th><th className="p-2 text-right">Orders</th><th className="p-2 text-right">Set %</th>
                  <th className="p-2 text-right">Actual %</th><th className="p-2">Match</th><th className="p-2 text-right">Commission</th>
                  <th className="p-2 text-right">Cashback given</th><th className="p-2 text-right">Shop shares</th><th className="p-2 text-right">Datagod kept</th><th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => {
                  const rateKey = `${r.service_key}:${r.provider}`
                  const setRate = num(currentRates[rateKey] ?? "") ?? 0
                  const actual = actualRate(r)
                  const status = rateStatus(setRate, actual)
                  const digi = r.provider === "digiwapy"
                  const commission = digi ? r.expected_commission : r.actual_commission
                  const kept = commission - r.cashback_total - r.shop_share_total
                  const svc = HUBTEL_CS_SERVICES[r.service_key as keyof typeof HUBTEL_CS_SERVICES]
                  return (
                    <tr key={rateKey} className="border-t">
                      <td className="p-2"><div className="font-medium">{svc?.label ?? r.service_key}</div><div className="text-xs text-muted-foreground">{r.provider}</div></td>
                      <td className="p-2 text-right">{r.orders}</td>
                      <td className="p-2 text-right">{setRate}</td>
                      <td className="p-2 text-right">{actual === null ? "—" : actual.toFixed(3)}</td>
                      <td className="p-2">
                        {status === "ok" && <span className="text-emerald-600" title="Set rate matches actual">✓</span>}
                        {status === "warn" && <span className="text-amber-600" title="Set rate differs from actual">⚠</span>}
                      </td>
                      <td className="p-2 text-right">{gh(commission, 4)}{digi && <div className="text-xs text-muted-foreground">expected</div>}</td>
                      <td className="p-2 text-right">{gh(r.cashback_total, 4)}</td>
                      <td className="p-2 text-right">{gh(r.shop_share_total, 4)}</td>
                      <td className="p-2 text-right font-medium">{gh(kept, 4)}{digi && <div className="text-xs font-normal text-muted-foreground">expected</div>}</td>
                      <td className="p-2 text-right">
                        {actual !== null && <Button size="sm" variant="outline" onClick={() => onUseActual(rateKey, actual)}>Use actual</Button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">&quot;Use actual&quot; only fills the rate input above; click Save rates to apply it.</p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------------------------

export function CashbackTab({ authed }: { authed: Authed }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const rateInputs = useMemo(() => ({
    values,
    set: (k: string, v: string) => setValues(s => ({ ...s, [k]: v })),
    reset: (all: Record<string, string>) => setValues(all),
  }), [values])
  return (
    <div className="space-y-4">
      <CashbackSettingsCard authed={authed} rateInputs={rateInputs} />
      <CashbackReportCard authed={authed} currentRates={values} onUseActual={(k, r) => rateInputs.set(k, String(r))} />
    </div>
  )
}
