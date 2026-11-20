"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { adminFetch } from "../_lib/api"
import { airtimeFeeWarning, canSaveRates, rateChanges, rateDirtyCount, type RateRow } from "../_lib/rates-edit"
import type { EditTabProps } from "../_lib/tab-props"
import { SaveBar } from "./SaveBar"

const AIRTIME_SETTINGS = "/admin/airtime/settings"
const CASHBACK_SETTINGS = "/admin/hubtel-commission?tab=cashback"

export interface ServicesViewProps {
  editable: boolean
  rates: RateRow[]
  edits: Record<string, string>
  onEdit: (key: string, text: string) => void
  reason: string
  onReason: (r: string) => void
  busy: boolean
  onSave: () => void
  onDiscard: () => void
}

export function ServicesView(p: ServicesViewProps) {
  const dirty = rateDirtyCount(p.rates, p.edits)
  const check = canSaveRates(p.rates, p.edits, p.reason)
  return (
    <div className="space-y-4">
      {!p.editable ? (
        <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          System roles use the shared settings, so these values are read-only here. Change them in{" "}
          <Link href={AIRTIME_SETTINGS} className="font-medium text-primary underline">
            airtime settings
          </Link>{" "}
          and{" "}
          <Link href={CASHBACK_SETTINGS} className="font-medium text-primary underline">
            cashback settings
          </Link>
          .
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Leave a box blank to use the shared default. Values are percentages from 0 to 100.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border bg-card lg:max-w-3xl">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">Service</th>
              <th className="p-2">Role value (%)</th>
              <th className="p-2 text-right">In effect (%)</th>
            </tr>
          </thead>
          <tbody>
            {p.rates.map((r) => {
              const text = p.edits[r.service_key] ?? (r.value == null ? "" : String(r.value))
              return (
                <tr key={r.service_key} data-rate-row={r.service_key} className="border-t">
                  <td className="p-2 font-medium">{r.label}</td>
                  <td className="p-2">
                    {p.editable ? (
                      <Input
                        data-rate-input
                        aria-label={r.label}
                        inputMode="decimal"
                        className="h-8 w-24"
                        placeholder="default"
                        value={text}
                        disabled={p.busy}
                        onChange={(e) => p.onEdit(r.service_key, e.target.value)}
                      />
                    ) : (
                      <span className="tabular-nums">{r.value == null ? "default" : r.value}</span>
                    )}
                  </td>
                  <td className="p-2 text-right tabular-nums">{r.effective}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {p.editable ? (
        <SaveBar
          reason={p.reason}
          onReason={p.onReason}
          canSave={check.ok}
          why={check.why}
          busy={p.busy}
          dirty={dirty > 0}
          onSave={p.onSave}
          onDiscard={p.onDiscard}
          saveLabel={`Save ${dirty} change${dirty === 1 ? "" : "s"}`}
        />
      ) : null}
    </div>
  )
}

export function ServicesTab({ role, busy, setBusy, onError, onDirtyChange }: EditTabProps) {
  const [rates, setRates] = useState<RateRow[]>([])
  const [editable, setEditable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [reason, setReason] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await adminFetch<{ editable: boolean; rates: RateRow[] }>(`/api/admin/roles/${role.id}/rates`)
      setRates(data.rates)
      setEditable(data.editable)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load services")
    } finally {
      setLoading(false)
    }
  }, [role.id])

  useEffect(() => {
    load()
  }, [load])

  const dirty = rateDirtyCount(rates, edits)
  useEffect(() => {
    onDirtyChange(dirty > 0)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const reset = () => {
    setEdits({})
    setReason("")
  }

  const save = async () => {
    if (busy) return
    const r = rateChanges(rates, edits)
    if (!r.ok || r.changes.length === 0 || !canSaveRates(rates, edits, reason).ok) return
    const warning = airtimeFeeWarning(r.changes)
    if (warning && !window.confirm(warning)) return
    setBusy(true)
    try {
      await adminFetch(`/api/admin/roles/${role.id}/rates`, { method: "PUT", body: { changes: r.changes, reason: reason.trim() } })
      toast.success("Services saved")
      reset()
      await load()
    } catch (e) {
      await onError(e)
    } finally {
      setBusy(false)
    }
  }

  if (loading && rates.length === 0) {
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
    <ServicesView
      editable={editable}
      rates={rates}
      edits={edits}
      onEdit={(k, t) => setEdits((cur) => ({ ...cur, [k]: t }))}
      reason={reason}
      onReason={setReason}
      busy={busy}
      onSave={save}
      onDiscard={reset}
    />
  )
}
