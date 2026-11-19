"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface Props {
  reason: string
  onReason: (v: string) => void
  /** Pure result of the tab's own check (reason length, dirty, below-cost box...). */
  canSave: boolean
  /** Why Save is off, shown as a hint. */
  why?: string | null
  busy: boolean
  dirty: boolean
  onSave: () => void
  onDiscard?: () => void
  saveLabel?: string
  /** Extra controls (for example the loss checkbox) shown above the buttons. */
  children?: React.ReactNode
}

/** Reason (3+ characters) plus Save and Discard. Every hub write goes through one of these. */
export function SaveBar({ reason, onReason, canSave, why, busy, dirty, onSave, onDiscard, saveLabel = "Save", children }: Props) {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4" data-save-bar>
      {children}
      <div className="space-y-1">
        <Label htmlFor="savebar-reason">Reason</Label>
        <Input
          id="savebar-reason"
          value={reason}
          maxLength={300}
          placeholder="Why are you changing this? (min 3 characters)"
          onChange={(e) => onReason(e.target.value)}
        />
      </div>
      {why && dirty ? <p className="text-xs text-muted-foreground">{why}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button data-save onClick={onSave} disabled={busy || !canSave}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {saveLabel}
        </Button>
        {onDiscard ? (
          <Button variant="outline" data-discard onClick={onDiscard} disabled={busy || !dirty}>
            Discard
          </Button>
        ) : null}
      </div>
    </div>
  )
}
