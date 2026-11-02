"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, Save, Info, AlertCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { bulkPreview, computeChanges, warningFor, type BulkBase, type BulkMode, type CustomPriceRow } from "@/lib/pricing/custom-prices-dialog"

type Mode = "role" | "custom"
type SubTab = "manual" | "bulk"
const ALL = "all"

// Same look as the Data Bundles tab of /dashboard/shop-pricing: segmented tabs, network
// buttons with counts, a card per package, and a Bulk tab with a preview table. Unlike the
// shop page, nothing is saved per card: Bulk only fills the inputs, and one Save sends
// every change in a single request (the route validates the batch as a whole). Bulk mirrors the
// admin Packages bulk tool: all networks or one, a per-GB rate or a signed % adjustment of a
// chosen base, select all/none, and clearing custom prices in bulk.
export function CustomPricesDialog({ userId, userLabel, open, onOpenChange, onSaved }: {
  userId: string | null
  userLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (mode: Mode) => void
}) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [role, setRole] = useState("")
  const [mode, setMode] = useState<Mode>("role")
  const [savedMode, setSavedMode] = useState<Mode>("role")
  const [rows, setRows] = useState<CustomPriceRow[]>([])
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [showInvalid, setShowInvalid] = useState(false)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<SubTab>("manual")
  const [network, setNetwork] = useState("")
  const [bulkMode, setBulkMode] = useState<BulkMode>("per_gb")
  const [bulkBase, setBulkBase] = useState<BulkBase>("role")
  const [bulkRate, setBulkRate] = useState("")
  const [bulkNetwork, setBulkNetwork] = useState("")
  const [bulkSelected, setBulkSelected] = useState<Record<string, boolean>>({})

  const authHeaders = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
  }

  useEffect(() => {
    if (!open || !userId) return
    let cancelled = false
    setLoading(true)
    setServerErrors({})
    setShowInvalid(false)
    setTouched({})
    setLoadedFor(null)
    setSubTab("manual")
    setBulkRate("")
    setBulkSelected({})
    ;(async () => {
      try {
        const res = await fetch(`/api/admin/users/${userId}/custom-prices`, { headers: await authHeaders(), cache: "no-store" })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error || "Failed to load prices")
        if (cancelled) return
        setRole(json.user.role)
        setMode(json.user.pricing_mode)
        setSavedMode(json.user.pricing_mode)
        setRows(json.packages)
        setInputs(Object.fromEntries(json.packages.map((p: CustomPriceRow) => [p.id, p.custom_price == null ? "" : p.custom_price.toFixed(2)])))
        const first = json.packages[0]?.network ?? ""
        setNetwork(first)
        setBulkNetwork(ALL)
        setLoadedFor(userId)
      } catch (e) {
        if (cancelled) return
        toast.error(e instanceof Error ? e.message : "Failed to load prices")
        onOpenChange(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId])

  const networks = useMemo(() => [...new Set(rows.map((r) => r.network))], [rows])
  const customCount = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of rows) if ((inputs[r.id] ?? "").trim() !== "") counts[r.network] = (counts[r.network] ?? 0) + 1
    return counts
  }, [rows, inputs])
  const networkRows = useMemo(() => rows.filter((r) => r.network === network), [rows, network])

  const { changes, invalid } = useMemo(() => computeChanges(rows, inputs), [rows, inputs])
  const hasInvalid = Object.keys(invalid).length > 0
  const pending = changes.length + (mode !== savedMode ? 1 : 0)

  const setInput = (id: string, v: string) => {
    setInputs((s) => ({ ...s, [id]: v }))
    setServerErrors((s) => {
      if (!(id in s)) return s
      const rest = { ...s }
      delete rest[id]
      return rest
    })
  }

  const bulkScope = useMemo(() => rows.filter((r) => bulkNetwork === ALL || r.network === bulkNetwork), [rows, bulkNetwork])
  const preview = useMemo(() => {
    const out = bulkPreview(rows, inputs, { mode: bulkMode, value: bulkRate, base: bulkBase, network: bulkNetwork })
    return out ? new Map(out.map((p) => [p.row.id, p])) : null
  }, [rows, inputs, bulkMode, bulkRate, bulkBase, bulkNetwork])
  const isPicked = (id: string) => bulkSelected[id] !== false
  const pickedRows = bulkScope.filter((r) => isPicked(r.id))
  const allPicked = bulkScope.length > 0 && pickedRows.length === bulkScope.length
  const fillable = preview ? pickedRows.filter((r) => preview.get(r.id)?.newPrice != null) : []

  const setAllPicked = (on: boolean) =>
    setBulkSelected((s) => ({ ...s, ...Object.fromEntries(bulkScope.map((r) => [r.id, on])) }))

  const finishBulk = (message: string) => {
    if (bulkNetwork !== ALL) setNetwork(bulkNetwork)
    setSubTab("manual")
    toast.success(message)
  }

  const applyBulk = () => {
    if (!preview || fillable.length === 0) {
      toast.error("Nothing to apply")
      return
    }
    setInputs((s) => ({ ...s, ...Object.fromEntries(fillable.map((r) => [r.id, preview.get(r.id)!.newPrice!.toFixed(2)])) }))
    finishBulk(`Filled ${fillable.length} price${fillable.length === 1 ? "" : "s"}. Review, then Save.`)
  }

  const clearBulk = () => {
    const withPrice = pickedRows.filter((r) => (inputs[r.id] ?? "").trim() !== "")
    if (withPrice.length === 0) {
      toast.error("None of the selected packages has a custom price")
      return
    }
    setInputs((s) => ({ ...s, ...Object.fromEntries(withPrice.map((r) => [r.id, ""])) }))
    finishBulk(`Cleared ${withPrice.length} price${withPrice.length === 1 ? "" : "s"}. Review, then Save.`)
  }

  const save = async () => {
    if (!userId) return
    if (hasInvalid) {
      setShowInvalid(true)
      const firstBad = rows.find((r) => invalid[r.id])
      if (firstBad) {
        setNetwork(firstBad.network)
        setSubTab("manual")
      }
      toast.error("Fix the highlighted prices first")
      return
    }
    setSaving(true)
    setServerErrors({})
    try {
      const body: Record<string, unknown> = {}
      if (mode !== savedMode) body.pricing_mode = mode
      if (changes.length) body.prices = changes
      if (!Object.keys(body).length) {
        onOpenChange(false)
        return
      }
      const res = await fetch(`/api/admin/users/${userId}/custom-prices`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        // errors are keyed by index into `changes`; map back to package ids for the inputs.
        if (json.errors) {
          setServerErrors(Object.fromEntries(
            Object.entries(json.errors)
              .map(([i, msg]) => [changes[Number(i)]?.package_id, String(msg)] as const)
              .filter(([id]) => !!id),
          ))
          setSubTab("manual")
        }
        throw new Error(res.status === 429 ? "Too many requests, try again shortly" : json.error || "Failed to save")
      }
      toast.success("Prices saved")
      onSaved?.(mode)
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const segment = (active: boolean) =>
    `flex-1 rounded-xl py-2.5 text-sm font-bold transition ${active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-0 gap-0 sm:max-w-3xl">
        <div className="min-w-0 space-y-4 p-5 sm:p-6">
          <DialogHeader>
            <DialogTitle>Custom prices: {userLabel}</DialogTitle>
            <DialogDescription>
              Fixed data bundle prices for this user. A blank price uses their normal {role || "role"} price.
            </DialogDescription>
          </DialogHeader>

          {loading || loadedFor !== userId ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-[#1b388b]" />
            </div>
          ) : (
            <fieldset disabled={saving} className="space-y-4 min-w-0 border-0 p-0 m-0">
              <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1" role="radiogroup" aria-label="Pricing mode">
                {([["role", "Role price"], ["custom", "Custom price"]] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={mode === value}
                    onClick={() => setMode(value)}
                    className={segment(mode === value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {mode === "role" ? (
                <div className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-foreground">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <p>This user pays role prices. Custom prices below are saved but not in use until you switch to <span className="font-bold">Custom price</span>.</p>
                </div>
              ) : (
                <div className="rounded-2xl border border-success/30 bg-success/10 p-4 text-sm text-foreground">
                  This user pays the custom price wherever one is set. Packages left blank keep their normal {role || "role"} price.
                </div>
              )}
              {role === "sub_agent" && (
                <div className="flex items-start gap-3 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 text-sm text-foreground">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#1b388b]" />
                  <p>Custom prices apply to this sub-agent&apos;s dashboard and API orders. USSD and WhatsApp orders go through the parent&apos;s catalog and use the parent&apos;s price.</p>
                </div>
              )}

              <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1">
                {(["manual", "bulk"] as SubTab[]).map((t) => (
                  <button key={t} type="button" onClick={() => setSubTab(t)} className={`${segment(subTab === t)} capitalize`}>
                    {t}
                  </button>
                ))}
              </div>

              {subTab === "manual" ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {networks.map((net) => (
                      <button
                        key={net}
                        type="button"
                        onClick={() => setNetwork(net)}
                        className={`flex items-center justify-between gap-2 rounded-2xl border-2 px-3 py-2.5 text-sm font-bold transition ${network === net ? "border-[#1b388b] bg-[#1b388b]/5 text-[#1b388b]" : "border-border bg-card text-foreground"} clay`}
                      >
                        <span className="truncate">{net}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs" aria-label={`${customCount[net] || 0} custom prices`}>{customCount[net] || 0}</span>
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {networkRows.map((r) => {
                      const value = inputs[r.id] ?? ""
                      const inlineError = serverErrors[r.id] ?? (showInvalid || touched[r.id] ? invalid[r.id] : undefined)
                      const warn = inlineError ? null : warningFor(r, value)
                      const unavailable = r.is_available === false
                      const parsed = parseFloat(value)
                      const diff = value.trim() !== "" && isFinite(parsed) ? parsed - r.role_price : null
                      return (
                        <div key={r.id} className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-bold text-foreground">
                              {r.size}GB
                              {unavailable && <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warning">Unavailable</span>}
                            </p>
                            <span className="text-xs text-muted-foreground">Role: GH₵{r.role_price.toFixed(2)}</span>
                          </div>
                          <div className={`mt-2 flex items-center gap-1 rounded-xl border px-3 py-2 ${inlineError ? "border-destructive/60 bg-destructive/5" : "border-success/40 bg-success/5"}`}>
                            <span className="text-xs font-semibold text-muted-foreground">GHS</span>
                            <input
                              inputMode="decimal"
                              placeholder="Role price"
                              aria-label={`${r.network} ${r.size}GB${unavailable ? " (unavailable)" : ""} custom price`}
                              aria-invalid={!!inlineError}
                              aria-describedby={inlineError || warn ? `msg-${r.id}` : undefined}
                              onBlur={() => setTouched((s) => ({ ...s, [r.id]: true }))}
                              value={value}
                              onChange={(e) => setInput(r.id, e.target.value)}
                              className="w-full bg-transparent text-sm font-bold text-foreground placeholder:font-normal placeholder:text-muted-foreground focus:outline-none"
                            />
                            {value && (
                              <button type="button" onClick={() => setInput(r.id, "")} className="shrink-0 text-xs font-semibold text-muted-foreground hover:text-foreground">
                                Clear
                              </button>
                            )}
                          </div>
                          <div className="mt-1 flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">
                              {r.dealer_price != null && r.dealer_price > 0 ? `Dealer GH₵${r.dealer_price.toFixed(2)}` : "vs role price"}
                            </span>
                            {diff === null ? (
                              <span className="text-muted-foreground">Uses role price</span>
                            ) : (
                              <span className={`font-semibold ${diff <= 0 ? "text-success" : "text-warning"}`}>
                                {diff > 0 ? "+" : diff < 0 ? "−" : ""}GH₵{Math.abs(diff).toFixed(2)} {diff <= 0 ? "off" : "more"}
                              </span>
                            )}
                          </div>
                          {(inlineError || warn) && (
                            <p id={`msg-${r.id}`} className={`mt-1 text-xs ${inlineError ? "text-destructive" : "text-warning"}`}>{inlineError ?? warn}</p>
                          )}
                        </div>
                      )
                    })}
                    {networkRows.length === 0 && (
                      <p className="col-span-2 py-8 text-center text-sm text-muted-foreground">No {network} packages.</p>
                    )}
                  </div>
                </>
              ) : (
                <div className="rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-bold text-foreground">Bulk Pricing</p>
                    <div className="inline-flex gap-1 rounded-full bg-muted p-1">
                      <button type="button" onClick={() => setBulkMode("per_gb")} className={`rounded-full px-3 py-1.5 text-xs font-bold ${bulkMode === "per_gb" ? "bg-[#1b388b] text-white" : "text-muted-foreground"}`}>Rate per GB (GHS)</button>
                      <button type="button" onClick={() => setBulkMode("percent")} className={`rounded-full px-3 py-1.5 text-xs font-bold ${bulkMode === "percent" ? "bg-[#1b388b] text-white" : "text-muted-foreground"}`}>Adjust (%)</button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {bulkMode === "per_gb"
                      ? "Sets each price to size × rate, e.g. 4 means 1GB → GHS 4.00, 2GB → GHS 8.00."
                      : "Moves the chosen base by this percentage: -10 is 10% less, +5 is 5% more."}
                    {" "}Apply fills the prices for review; nothing is saved until you press Save.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <select
                      value={bulkNetwork}
                      onChange={(e) => setBulkNetwork(e.target.value)}
                      aria-label="Network"
                      className="rounded-xl border border-white/60 dark:border-white/5 bg-background px-3 py-2.5 text-sm font-bold clay-inset"
                    >
                      <option value={ALL}>All networks</option>
                      {networks.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    {bulkMode === "percent" && (
                      <select
                        value={bulkBase}
                        onChange={(e) => setBulkBase(e.target.value as BulkBase)}
                        aria-label="Adjust from"
                        className="rounded-xl border border-white/60 dark:border-white/5 bg-background px-3 py-2.5 text-sm font-bold clay-inset"
                      >
                        <option value="role">of role price</option>
                        <option value="dealer">of dealer price</option>
                        <option value="custom">of current custom price</option>
                      </select>
                    )}
                    <div className="flex min-w-[8rem] flex-1 items-center gap-1 rounded-xl border border-white/60 dark:border-white/5 bg-card px-3 py-2.5 clay">
                      <span className="text-xs font-semibold text-muted-foreground">{bulkMode === "per_gb" ? "GHS/GB" : "%"}</span>
                      <input
                        inputMode="decimal"
                        value={bulkRate}
                        onChange={(e) => setBulkRate(e.target.value)}
                        placeholder={bulkMode === "per_gb" ? "0.00" : "-10"}
                        aria-label={bulkMode === "per_gb" ? "Rate per GB" : "Percent adjustment"}
                        className="w-full bg-transparent text-sm font-bold focus:outline-none"
                      />
                    </div>
                  </div>

                  {bulkScope.length > 0 && (
                    <div className="overflow-x-auto rounded-xl border border-white/60 dark:border-white/5 bg-card clay">
                      <table className="w-full text-xs">
                        <thead className="border-b border-border">
                          <tr className="text-left text-muted-foreground">
                            <th className="p-2">
                              <input type="checkbox" aria-label="Select all" checked={allPicked} onChange={(e) => setAllPicked(e.target.checked)} />
                            </th>
                            {bulkNetwork === ALL && <th className="p-2">Network</th>}
                            <th className="p-2">Size</th>
                            <th className="p-2">Role</th>
                            <th className="p-2">Current</th>
                            <th className="p-2">New</th>
                            <th className="p-2">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {bulkScope.map((r) => {
                            const p = preview?.get(r.id)
                            const current = (inputs[r.id] ?? "").trim()
                            const status = !preview
                              ? null
                              : p?.newPrice == null
                                ? { label: p?.reason ?? "Skipped", cls: "bg-destructive/15 text-destructive" }
                                : p.warn
                                  ? { label: p.warn.startsWith("Below") ? "Below dealer" : "Above role", cls: "bg-warning/15 text-warning" }
                                  : { label: "Will fill", cls: "bg-success/15 text-success" }
                            return (
                              <tr key={r.id} className={isPicked(r.id) ? "" : "opacity-50"}>
                                <td className="p-2">
                                  <input
                                    type="checkbox"
                                    aria-label={`Include ${r.network} ${r.size}GB`}
                                    checked={isPicked(r.id)}
                                    onChange={(e) => setBulkSelected((s) => ({ ...s, [r.id]: e.target.checked }))}
                                  />
                                </td>
                                {bulkNetwork === ALL && <td className="p-2 whitespace-nowrap">{r.network}</td>}
                                <td className="p-2 font-bold">{r.size}GB</td>
                                <td className="p-2">GH₵{r.role_price.toFixed(2)}</td>
                                <td className="p-2">{current && isFinite(Number(current)) ? `GH₵${Number(current).toFixed(2)}` : "—"}</td>
                                <td className="p-2 font-semibold">{p?.newPrice != null ? `GH₵${p.newPrice.toFixed(2)}` : "—"}</td>
                                <td className="p-2">
                                  {status && <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${status.cls}`}>{status.label}</span>}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="button" onClick={applyBulk} disabled={fillable.length === 0} className="flex-1 rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
                      Apply to {fillable.length || ""} price{fillable.length === 1 ? "" : "s"}
                    </Button>
                    <Button type="button" variant="outline" onClick={clearBulk} disabled={pickedRows.length === 0} className="rounded-2xl">
                      Clear selected
                    </Button>
                  </div>
                </div>
              )}
            </fieldset>
          )}
        </div>

        {!loading && loadedFor === userId && (
          <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-border bg-background/95 px-5 py-3 backdrop-blur sm:px-6">
            <p className="text-xs text-muted-foreground">
              {pending === 0 ? "No changes" : `${pending} unsaved change${pending === 1 ? "" : "s"}`}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving} className="rounded-xl">Cancel</Button>
              <Button onClick={save} disabled={saving} className="rounded-xl bg-success text-white hover:bg-success/90">
                {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
