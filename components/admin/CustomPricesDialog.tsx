"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { computeChanges, warningFor, type CustomPriceRow } from "@/lib/pricing/custom-prices-dialog"

type Mode = "role" | "custom"

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

  const byNetwork = useMemo(() => {
    const m = new Map<string, CustomPriceRow[]>()
    for (const r of rows) m.set(r.network, [...(m.get(r.network) ?? []), r])
    return [...m.entries()]
  }, [rows])

  const { changes, invalid } = useMemo(() => computeChanges(rows, inputs), [rows, inputs])
  const hasInvalid = Object.keys(invalid).length > 0

  const save = async () => {
    if (!userId) return
    if (hasInvalid) {
      setShowInvalid(true)
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

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o) }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Custom prices: {userLabel}</DialogTitle>
          <DialogDescription>
            Fixed data bundle prices for this user. A blank price uses their normal {role || "role"} price.
          </DialogDescription>
        </DialogHeader>

        {loading || loadedFor !== userId ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5">
            <fieldset disabled={saving} className="space-y-5 min-w-0 border-0 p-0 m-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">Pricing</span>
              <ToggleGroup
                type="single"
                variant="outline"
                value={mode}
                onValueChange={(v) => { if (v === "role" || v === "custom") setMode(v) }}
                aria-label="Pricing mode"
              >
                <ToggleGroupItem value="role" className="px-3 text-sm">Role price</ToggleGroupItem>
                <ToggleGroupItem value="custom" className="px-3 text-sm">Custom price</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {mode === "role" && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                This user pays role prices. Custom prices below are saved but not in use until you switch to Custom price.
              </p>
            )}
            {role === "sub_agent" && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                Custom prices apply to this sub-agent&apos;s dashboard and API orders. USSD and WhatsApp orders go
                through the parent&apos;s catalog and use the parent&apos;s price.
              </p>
            )}

            {byNetwork.map(([network, list]) => (
              <section key={network} className="space-y-2">
                <h3 className="text-sm font-semibold">{network}</h3>
                {list.map((r) => {
                  const inlineError = serverErrors[r.id] ?? (showInvalid || touched[r.id] ? invalid[r.id] : undefined)
                  const warn = inlineError ? null : warningFor(r, inputs[r.id] ?? "")
                  const unavailable = r.is_available === false
                  return (
                    <div key={r.id} className="grid grid-cols-[4rem_1fr_7rem_auto] items-center gap-2 text-sm">
                      <span className="font-medium">
                        {r.size}GB
                        {unavailable && <span className="block text-[10px] font-normal uppercase tracking-wide text-warning">Unavailable</span>}
                      </span>
                      <span className="text-muted-foreground">
                        Role GHS {r.role_price.toFixed(2)}
                        {r.dealer_price != null && r.dealer_price > 0 && <> · Dealer {r.dealer_price.toFixed(2)}</>}
                      </span>
                      <Input
                        inputMode="decimal"
                        placeholder="—"
                        aria-label={`${network} ${r.size}GB${unavailable ? " (unavailable)" : ""} custom price`}
                        aria-invalid={!!inlineError}
                        aria-describedby={inlineError || warn ? `msg-${r.id}` : undefined}
                        onBlur={() => setTouched((s) => ({ ...s, [r.id]: true }))}
                        value={inputs[r.id] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value
                          setInputs((s) => ({ ...s, [r.id]: v }))
                          setServerErrors((s) => {
                            if (!(r.id in s)) return s
                            const rest = { ...s }
                            delete rest[r.id]
                            return rest
                          })
                        }}
                      />
                      <Button type="button" variant="ghost" size="sm" disabled={!inputs[r.id]} onClick={() => {
                        setInputs((s) => ({ ...s, [r.id]: "" }))
                        setServerErrors((s) => {
                          const rest = { ...s }
                          delete rest[r.id]
                          return rest
                        })
                      }}>
                        Clear
                      </Button>
                      {(inlineError || warn) && (
                        <p id={`msg-${r.id}`} className={`col-span-4 text-xs ${inlineError ? "text-destructive" : "text-warning"}`}>{inlineError ?? warn}</p>
                      )}
                    </div>
                  )
                })}
              </section>
            ))}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </div>
            </fieldset>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
