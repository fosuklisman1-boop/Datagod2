"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AIRTIME_NETWORKS, PRIZE_TYPES, PRIZE_TYPE_LABEL, MAX_LABEL, MAX_PRESET_NAME, type PrizeFields, type PrizeType,
} from "@/lib/leaderboard/prizes"

export interface PackageOption { id: string; network: string; size: string; label: string }
export interface PresetOption extends PrizeFields { id: string; name: string }

interface Draft {
  prize_type: PrizeType | ""
  label: string
  amount: string
  network: string
  package_id: string
  duration_days: string
}

const EMPTY: Draft = { prize_type: "", label: "", amount: "", network: "", package_id: "", duration_days: "" }

function toDraft(p: Partial<PrizeFields> | null | undefined): Draft {
  if (!p) return EMPTY
  return {
    prize_type: p.prize_type ?? "",
    label: p.label ?? "",
    amount: p.amount != null ? String(p.amount) : "",
    network: p.network ?? "",
    package_id: p.package_id ?? "",
    duration_days: p.duration_days != null ? String(p.duration_days) : "",
  }
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /** Preset mode asks for a name and hides the preset picker. */
  mode: "prize" | "preset"
  initial?: Partial<PrizeFields> | null
  presets: PresetOption[]
  packages: PackageOption[]
  onSubmit: (input: { name?: string; prize: Record<string, unknown> }) => Promise<string | null>
}

/** Shared form for a rank's prize and for a preset. `onSubmit` returns an error message or null. */
export function PrizeFormDialog({ open, onOpenChange, title, description, mode, initial, presets, packages, onSubmit }: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(toDraft(initial))
    setName("")
    setError("")
  }, [open, initial])

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  async function save() {
    setSaving(true)
    setError("")
    const prize: Record<string, unknown> = { prize_type: draft.prize_type, label: draft.label }
    if (draft.prize_type === "wallet_topup" || draft.prize_type === "airtime") prize.amount = draft.amount
    if (draft.prize_type === "airtime") prize.network = draft.network
    if (draft.prize_type === "data_bundle") prize.package_id = draft.package_id
    if (draft.prize_type === "role_upgrade") prize.duration_days = Number(draft.duration_days)
    const message = await onSubmit({ name: mode === "preset" ? name : undefined, prize })
    setSaving(false)
    if (message) setError(message)
    else onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {mode === "prize" && presets.length > 0 && (
            <div className="space-y-1.5">
              <Label>Start from a preset</Label>
              <Select onValueChange={(id) => { const p = presets.find((x) => x.id === id); if (p) setDraft(toDraft(p)) }}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Choose a preset (optional)" /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {mode === "preset" && (
            <div className="space-y-1.5">
              <Label htmlFor="preset-name">Preset name</Label>
              <Input id="preset-name" value={name} maxLength={MAX_PRESET_NAME} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gold — GH₵100 cash" />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Prize type</Label>
            <Select value={draft.prize_type} onValueChange={(v) => set({ prize_type: v as PrizeType })}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose a type" /></SelectTrigger>
              <SelectContent>
                {PRIZE_TYPES.map((t) => <SelectItem key={t} value={t}>{PRIZE_TYPE_LABEL[t]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {(draft.prize_type === "wallet_topup" || draft.prize_type === "airtime") && (
            <div className="space-y-1.5">
              <Label htmlFor="prize-amount">Amount (GH₵)</Label>
              <Input id="prize-amount" inputMode="decimal" value={draft.amount} onChange={(e) => set({ amount: e.target.value })} placeholder="50" />
            </div>
          )}

          {draft.prize_type === "airtime" && (
            <div className="space-y-1.5">
              <Label>Network</Label>
              <Select value={draft.network} onValueChange={(v) => set({ network: v })}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Choose a network" /></SelectTrigger>
                <SelectContent>
                  {AIRTIME_NETWORKS.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {draft.prize_type === "data_bundle" && (
            <div className="space-y-1.5">
              <Label>Data bundle</Label>
              <Select value={draft.package_id} onValueChange={(v) => set({ package_id: v })}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Choose a bundle" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {packages.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {draft.prize_type === "role_upgrade" && (
            <div className="space-y-1.5">
              <Label htmlFor="prize-days">Dealer upgrade length (days)</Label>
              <Input id="prize-days" inputMode="numeric" value={draft.duration_days} onChange={(e) => set({ duration_days: e.target.value })} placeholder="15" />
              <p className="text-xs text-muted-foreground">The winner becomes a dealer for this many days, then returns to their previous role.</p>
            </div>
          )}

          {draft.prize_type && (
            <div className="space-y-1.5">
              <Label htmlFor="prize-label">Prize name shown to users {draft.prize_type !== "manual" && <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
              <Input
                id="prize-label"
                value={draft.label}
                maxLength={MAX_LABEL}
                onChange={(e) => set({ label: e.target.value })}
                placeholder={draft.prize_type === "manual" ? "e.g. Branded T-shirt" : "Leave blank to name it automatically"}
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Close</Button>
          <Button onClick={save} disabled={saving || !draft.prize_type}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
