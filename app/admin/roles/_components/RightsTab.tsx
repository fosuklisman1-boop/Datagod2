"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { CAPABILITIES, CAPABILITY_GROUPS, type Capability } from "@/lib/roles/capabilities"
import { validateReason } from "@/lib/roles/admin/validate"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { adminFetch } from "../_lib/api"
import { capsDirty, rightsConfirmText, toggleCap } from "../_lib/rights-edit"
import { copySources, type EditTabProps } from "../_lib/tab-props"
import { ReasonDialog } from "./ReasonDialog"
import { SaveBar } from "./SaveBar"

export interface RightsViewProps {
  editable: boolean
  caps: Capability[]
  dirty: boolean
  onToggle: (cap: Capability, on: boolean) => void
  reason: string
  onReason: (r: string) => void
  busy: boolean
  onSave: () => void
  onDiscard: () => void
  copyRoles: { id: string; name: string }[]
  copyFrom: string
  onCopyFrom: (id: string) => void
  onLoadCopy: () => void
}

export function RightsView(p: RightsViewProps) {
  const reasonOk = validateReason(p.reason).ok
  return (
    <div className="space-y-4">
      {!p.editable ? (
        <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          This role&apos;s rights are fixed and read-only. Admin has every right and sub-agents keep their own menu.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-start">
        {CAPABILITY_GROUPS.map((g) => (
          <Card key={g.id}>
            <CardHeader>
              <CardTitle className="text-base">{g.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {CAPABILITIES.filter((c) => c.group === g.id).map((c) => {
                const on = p.caps.includes(c.key)
                return (
                  <div key={c.key}>
                    {p.editable ? (
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={on}
                          disabled={p.busy}
                          onChange={(e) => p.onToggle(c.key, e.target.checked)}
                        />
                        <span>
                          {c.label}
                          {c.hint ? <span className="block text-xs text-muted-foreground">{c.hint}</span> : null}
                        </span>
                      </label>
                    ) : (
                      <div className="text-sm">
                        <span className={on ? "" : "text-muted-foreground line-through"}>{c.label}</span>
                        {c.hint ? <span className="block text-xs text-muted-foreground">{c.hint}</span> : null}
                      </div>
                    )}
                  </div>
                )
              })}
            </CardContent>
          </Card>
        ))}
      </div>
      {p.editable ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="rights-copy" className="text-sm font-medium">
              Copy from role
            </label>
            <select
              id="rights-copy"
              value={p.copyFrom}
              onChange={(e) => p.onCopyFrom(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Choose a role</option>
              {p.copyRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <Button type="button" variant="outline" onClick={p.onLoadCopy} disabled={p.busy || !p.copyFrom}>
              Load rights
            </Button>
          </div>
          <SaveBar
            reason={p.reason}
            onReason={p.onReason}
            canSave={p.dirty && reasonOk}
            why={!p.dirty ? "No changes" : !reasonOk ? "Add a reason (3+ characters)" : null}
            busy={p.busy}
            dirty={p.dirty}
            onSave={p.onSave}
            onDiscard={p.onDiscard}
          />
        </>
      ) : null}
    </div>
  )
}

export function RightsTab({ role, roles, busy, setBusy, onError, onDirtyChange, onChanged }: EditTabProps) {
  const [loaded, setLoaded] = useState<Capability[]>([])
  const [caps, setCaps] = useState<Capability[]>([])
  const [editable, setEditable] = useState(false)
  const [memberCount, setMemberCount] = useState(role.member_count)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [copyFrom, setCopyFrom] = useState("")
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await adminFetch<{ editable: boolean; capabilities: Capability[]; member_count: number }>(
        `/api/admin/roles/${role.id}/permissions`,
      )
      setLoaded(data.capabilities)
      setCaps(data.capabilities)
      setEditable(data.editable)
      if (Number.isFinite(data.member_count)) setMemberCount(data.member_count)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load rights")
    } finally {
      setLoading(false)
    }
  }, [role.id])

  useEffect(() => {
    load()
  }, [load])

  const dirty = capsDirty(loaded, caps)
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const discard = () => {
    setCaps(loaded)
    setReason("")
  }

  const loadCopy = async () => {
    if (!copyFrom || busy) return
    setBusy(true)
    try {
      const data = await adminFetch<{ capabilities: Capability[] }>(`/api/admin/roles/${copyFrom}/permissions`)
      setCaps(data.capabilities)
      toast.success("Rights copied into the form. Save to apply.")
    } catch (e) {
      await onError(e)
    } finally {
      setBusy(false)
    }
  }

  const save = async (confirmedReason: string) => {
    if (busy) return
    setBusy(true)
    try {
      await adminFetch(`/api/admin/roles/${role.id}/permissions`, {
        method: "PUT",
        body: { capabilities: caps, reason: confirmedReason },
      })
      toast.success("Rights saved")
      setConfirming(false)
      setReason("")
      await load()
      await onChanged?.()
    } catch (e) {
      setConfirming(false)
      await onError(e)
    } finally {
      setBusy(false)
    }
  }

  if (loading && loaded.length === 0 && !editable) {
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
    <>
      <RightsView
        editable={editable}
        caps={caps}
        dirty={dirty}
        onToggle={(c, on) => setCaps((cur) => toggleCap(cur, c, on))}
        reason={reason}
        onReason={setReason}
        busy={busy}
        onSave={() => setConfirming(true)}
        onDiscard={discard}
        copyRoles={copySources(roles, role.id)}
        copyFrom={copyFrom}
        onCopyFrom={setCopyFrom}
        onLoadCopy={loadCopy}
      />
      {/* The dialog is the confirm step: it shows the member count (and the empty-set warning) with the bar's reason prefilled. */}
      <ReasonDialog
        open={confirming}
        title={`Save rights for ${role.name}?`}
        description={rightsConfirmText(memberCount, caps.length)}
        confirmLabel={caps.length === 0 ? "Save empty set" : "Save rights"}
        destructive={caps.length === 0}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={save}
        initialReason={reason}
      />
    </>
  )
}
