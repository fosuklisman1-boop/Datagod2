"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, adminFetch } from "../_lib/api"
import {
  belowCostIds, bulkPublicPreview, bulkRolePreview, buildPricesPut, canSavePrices, cellState, dirtyChanges, marginOf, sourceMapFrom,
  type Edits, type PriceRow,
} from "../_lib/prices-grid"
import { copySources, type EditTabProps } from "../_lib/tab-props"
import { SaveBar } from "./SaveBar"

const ghs = (n: number) => n.toFixed(2)

export interface PricesViewProps {
  editable: boolean
  rows: PriceRow[]
  edits: Edits
  onEdit: (id: string, text: string) => void
  network: string
  onNetwork: (n: string) => void
  lossOk: boolean
  onLossOk: (b: boolean) => void
  reason: string
  onReason: (r: string) => void
  busy: boolean
  /** Ids the server rejected as below cost (409), highlighted even if the local check disagreed. */
  highlight: ReadonlySet<string>
  bulkPercent: string
  onBulkPercent: (t: string) => void
  bulkDelta: string
  onBulkDelta: (t: string) => void
  bulkMessage: string | null
  onApplyPercent: () => void
  onApplyDelta: () => void
  copyRoles: { id: string; name: string }[]
  copyFrom: string
  onCopyFrom: (id: string) => void
  onLoadCopy: () => void
  copyNote: string | null
  onSave: () => void
  onDiscard: () => void
}

/** Presentational grid. All state lives in PricesTab so this renders statically in tests. */
export function PricesView(p: PricesViewProps) {
  const networks = useMemoNetworks(p.rows)
  const shown = p.network === "all" ? p.rows : p.rows.filter((r) => r.network === p.network)
  const below = new Set(belowCostIds(p.rows, p.edits))
  const { changes } = dirtyChanges(p.rows, p.edits)
  const base = canSavePrices({ rows: p.rows, edits: p.edits, lossOk: p.lossOk, reason: p.reason })
  const check =
    base.ok && p.highlight.size > 0 && !p.lossOk
      ? { ok: false, why: "The server found rows below cost: tick the loss box to sell at a loss" }
      : base

  return (
    <div className="space-y-4">
      {!p.editable ? (
        <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          This role&apos;s prices are read-only. Admin and sub-agent roles have no price tier of their own.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-start">
        <div className="space-y-4 lg:col-span-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="price-network">Network</Label>
            <select
              id="price-network"
              value={p.network}
              onChange={(e) => p.onNetwork(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="all">All networks</option>
              {networks.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">{shown.length} packages</span>
          </div>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Package</th>
                  <th className="p-2 text-right">Public</th>
                  <th className="p-2 text-right">Our cost</th>
                  <th className="p-2">Role price</th>
                  <th className="p-2 text-right">Effective</th>
                  <th className="p-2 text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const cell = cellState(r, p.edits[r.id])
                  const dirty = cell.kind === "set" || cell.kind === "clear"
                  const isBelow = below.has(r.id) || p.highlight.has(r.id)
                  const shownPrice = cell.kind === "set" ? cell.price : r.effective_price
                  const m = cell.kind === "clear" ? null : marginOf(r, shownPrice)
                  const text = p.edits[r.id] ?? (r.role_price == null ? "" : String(r.role_price))
                  return (
                    <tr
                      key={r.id}
                      data-price-row={r.id}
                      {...(isBelow ? { "data-below-cost": "" } : {})}
                      {...(dirty ? { "data-dirty": "" } : {})}
                      className={`border-t ${isBelow ? "bg-destructive/10" : dirty ? "bg-primary/10" : ""}`}
                    >
                      <td className="p-2">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.network}
                          {r.is_available ? "" : " (unavailable)"}
                        </div>
                      </td>
                      <td className="p-2 text-right tabular-nums">{ghs(r.price)}</td>
                      <td className="p-2 text-right tabular-nums" data-cost={r.cost_price == null ? "—" : ghs(r.cost_price)}>
                        {r.cost_price == null ? "—" : ghs(r.cost_price)}
                      </td>
                      <td className="p-2">
                        {p.editable ? (
                          <Input
                            aria-label={`Role price for ${r.name}`}
                            inputMode="decimal"
                            className={`h-8 w-24 ${cell.kind === "invalid" ? "border-destructive" : ""}`}
                            placeholder="ladder"
                            value={text}
                            disabled={p.busy}
                            onChange={(e) => p.onEdit(r.id, e.target.value)}
                          />
                        ) : (
                          <span className="tabular-nums">{r.role_price == null ? "ladder" : ghs(r.role_price)}</span>
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {cell.kind === "clear" ? "ladder" : ghs(shownPrice)}
                      </td>
                      <td className={`p-2 text-right tabular-nums ${m && m.amount < 0 ? "text-destructive" : ""}`}>
                        {m ? `${ghs(m.amount)} (${m.percent}%)` : "—"}
                      </td>
                    </tr>
                  )
                })}
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-muted-foreground">
                      No packages
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        {p.editable ? (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Bulk fill</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Fills the grid below as unsaved edits for the packages shown. Nothing is saved until you press Save.
                </p>
                <div className="space-y-1">
                  <Label htmlFor="bulk-percent">Public price minus %</Label>
                  <div className="flex gap-2">
                    <Input id="bulk-percent" inputMode="decimal" placeholder="e.g. 5" value={p.bulkPercent} onChange={(e) => p.onBulkPercent(e.target.value)} />
                    <Button type="button" variant="outline" onClick={p.onApplyPercent} disabled={p.busy}>
                      Fill
                    </Button>
                  </div>
                </div>
                <div className="space-y-2 border-t pt-3">
                  <Label htmlFor="copy-from">Copy from role</Label>
                  <div className="flex gap-2">
                    <select
                      id="copy-from"
                      value={p.copyFrom}
                      onChange={(e) => p.onCopyFrom(e.target.value)}
                      className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="">Choose a role</option>
                      {p.copyRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <Button type="button" variant="outline" onClick={p.onLoadCopy} disabled={p.busy || !p.copyFrom}>
                      Load
                    </Button>
                  </div>
                  {p.copyNote ? <p className="text-xs text-muted-foreground">{p.copyNote}</p> : null}
                  <Label htmlFor="bulk-delta">Add or subtract GHS</Label>
                  <div className="flex gap-2">
                    <Input id="bulk-delta" inputMode="decimal" placeholder="e.g. -0.50" value={p.bulkDelta} onChange={(e) => p.onBulkDelta(e.target.value)} />
                    <Button type="button" variant="outline" onClick={p.onApplyDelta} disabled={p.busy}>
                      Fill
                    </Button>
                  </div>
                </div>
                {p.bulkMessage ? <p className="text-sm text-destructive">{p.bulkMessage}</p> : null}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>

      {p.editable ? (
        <SaveBar
          reason={p.reason}
          onReason={p.onReason}
          canSave={check.ok}
          why={check.why}
          busy={p.busy}
          dirty={changes.length > 0}
          onSave={p.onSave}
          onDiscard={p.onDiscard}
          saveLabel={`Save ${changes.length} change${changes.length === 1 ? "" : "s"}`}
        >
          {below.size > 0 || p.highlight.size > 0 ? (
            <label className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <input type="checkbox" className="mt-1" checked={p.lossOk} onChange={(e) => p.onLossOk(e.target.checked)} />
              <span>
                I know this sells at a loss. {Math.max(below.size, p.highlight.size)} row{Math.max(below.size, p.highlight.size) === 1 ? "" : "s"} priced under our cost.
              </span>
            </label>
          ) : null}
        </SaveBar>
      ) : null}
    </div>
  )
}

function useMemoNetworks(rows: PriceRow[]): string[] {
  return useMemo(() => Array.from(new Set(rows.map((r) => r.network))).sort(), [rows])
}

interface PricesResponse {
  editable: boolean
  packages: PriceRow[]
}

export function PricesTab({ role, roles, busy, setBusy, onError, onDirtyChange }: EditTabProps) {
  const [rows, setRows] = useState<PriceRow[]>([])
  const [editable, setEditable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Edits>({})
  const [network, setNetwork] = useState("all")
  const [lossOk, setLossOk] = useState(false)
  const [reason, setReason] = useState("")
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set())
  const [bulkPercent, setBulkPercent] = useState("")
  const [bulkDelta, setBulkDelta] = useState("")
  const [bulkMessage, setBulkMessage] = useState<string | null>(null)
  const [copyFrom, setCopyFrom] = useState("")
  const [source, setSource] = useState<Map<string, number> | null>(null)
  const [copyNote, setCopyNote] = useState<string | null>(null)

  const reset = () => {
    setEdits({})
    setLossOk(false)
    setReason("")
    setHighlight(new Set())
    setBulkMessage(null)
  }

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await adminFetch<PricesResponse>(`/api/admin/roles/${role.id}/prices`)
      setRows(data.packages)
      setEditable(data.editable)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load prices")
    } finally {
      setLoading(false)
    }
  }, [role.id])

  useEffect(() => {
    load()
  }, [load])

  const changes = dirtyChanges(rows, edits).changes.length
  useEffect(() => {
    onDirtyChange(changes > 0)
    return () => onDirtyChange(false)
  }, [changes, onDirtyChange])

  const visible = useMemo(() => (network === "all" ? rows : rows.filter((r) => r.network === network)), [rows, network])

  const mergeEdits = (next: Edits, skipped: number, what: string) => {
    setEdits((cur) => ({ ...cur, ...next }))
    setBulkMessage(skipped > 0 ? `${skipped} package${skipped === 1 ? "" : "s"} skipped (price would be zero or less) for ${what}.` : null)
  }

  const applyPercent = () => {
    const r = bulkPublicPreview(visible, bulkPercent)
    if (!r.ok) return setBulkMessage(r.error)
    mergeEdits(r.edits, r.skipped, "public minus %")
  }

  const applyDelta = () => {
    if (!source) return setBulkMessage("Load a source role first.")
    const r = bulkRolePreview(source, visible, bulkDelta)
    if (!r.ok) return setBulkMessage(r.error)
    mergeEdits(r.edits, r.skipped, "copy from role")
  }

  const loadCopy = async () => {
    if (!copyFrom || busy) return
    setBusy(true)
    try {
      const data = await adminFetch<PricesResponse>(`/api/admin/roles/${copyFrom}/prices`)
      const s = sourceMapFrom(data.packages)
      const name = roles.find((r) => r.id === copyFrom)?.name ?? "that role"
      setSource(s.map)
      setCopyNote(`Loaded ${s.map.size} prices from ${name}: ${s.usedRolePrice} set on the role, ${s.usedEffective} using its effective price.`)
      setBulkMessage(null)
    } catch (e) {
      setSource(null)
      setCopyNote(null)
      setBulkMessage(e instanceof Error ? e.message : "Could not load that role's prices")
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (busy) return
    if (!canSavePrices({ rows, edits, lossOk, reason }).ok) return
    if (highlight.size > 0 && !lossOk) return
    setBusy(true)
    try {
      await adminFetch(`/api/admin/roles/${role.id}/prices`, {
        method: "PUT",
        body: buildPricesPut(rows, edits, lossOk, reason, highlight.size > 0),
      })
      toast.success("Prices saved")
      reset()
      await load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && Array.isArray(e.data.below_cost)) {
        setHighlight(new Set((e.data.below_cost as unknown[]).filter((x): x is string => typeof x === "string")))
      }
      await onError(e)
    } finally {
      setBusy(false)
    }
  }

  if (loading && rows.length === 0) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }
  if (loadError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button variant="outline" onClick={load}>
            <RefreshCw className="mr-2 h-4 w-4" /> Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <PricesView
      editable={editable}
      rows={rows}
      edits={edits}
      onEdit={(id, t) => {
        setEdits((cur) => ({ ...cur, [id]: t }))
        setHighlight((h) => (h.has(id) ? new Set([...h].filter((x) => x !== id)) : h))
      }}
      network={network}
      onNetwork={setNetwork}
      lossOk={lossOk}
      onLossOk={setLossOk}
      reason={reason}
      onReason={setReason}
      busy={busy}
      highlight={highlight}
      bulkPercent={bulkPercent}
      onBulkPercent={setBulkPercent}
      bulkDelta={bulkDelta}
      onBulkDelta={setBulkDelta}
      bulkMessage={bulkMessage}
      onApplyPercent={applyPercent}
      onApplyDelta={applyDelta}
      copyRoles={copySources(roles, role.id)}
      copyFrom={copyFrom}
      onCopyFrom={(id) => {
        setCopyFrom(id)
        setSource(null)
        setCopyNote(null)
      }}
      onLoadCopy={loadCopy}
      copyNote={copyNote}
      onSave={save}
      onDiscard={reset}
    />
  )
}
