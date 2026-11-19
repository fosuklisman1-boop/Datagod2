"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { defaultNewRank, validateCreateRoleForm, type CreateRoleBody } from "../_lib/create-form"
import type { HubRole } from "../_lib/ladder-view"

interface Props {
  open: boolean
  roles: HubRole[]
  /** Preset when opened from a row's Clone action. */
  cloneFrom: string | null
  busy: boolean
  onCancel: () => void
  onSubmit: (body: CreateRoleBody) => void
}

export function CreateRoleDialog({ open, roles, cloneFrom, busy, onCancel, onSubmit }: Props) {
  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")
  const [rank, setRank] = useState("")
  const [clone, setClone] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSlug("")
    setName("")
    setRank(String(defaultNewRank(roles)))
    setClone(cloneFrom ?? "")
    setReason("")
    setError(null)
    // roles intentionally not a dependency: do not reset the form when the list reloads under the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cloneFrom])

  const cloneable = roles.filter((r) => !r.archived_at && r.slug !== "admin")

  const submit = () => {
    const v = validateCreateRoleForm({ slug, name, rank, cloneFrom: clone, reason }, roles)
    if (!v.ok) {
      setError(v.error)
      return
    }
    setError(null)
    onSubmit(v.value)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{cloneFrom ? "Clone role" : "New role"}</DialogTitle>
          <DialogDescription>
            A higher rank is more senior. Cloning copies the source role&apos;s prices, services and rights.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="role-slug">Slug</Label>
            <Input id="role-slug" value={slug} maxLength={20} placeholder="e.g. gold" onChange={(e) => setSlug(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="role-name">Name</Label>
            <Input id="role-name" value={name} maxLength={40} placeholder="e.g. Gold dealer" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="role-rank">Rank</Label>
            <Input id="role-rank" inputMode="numeric" value={rank} onChange={(e) => setRank(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="role-clone">Copy from</Label>
            <select
              id="role-clone"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={clone}
              onChange={(e) => setClone(e.target.value)}
            >
              <option value="">Nothing (start empty)</option>
              {cloneable.map((r) => (
                <option key={r.id} value={r.slug}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="role-reason">Reason</Label>
            <Input id="role-reason" value={reason} maxLength={300} placeholder="min 3 characters" onChange={(e) => setReason(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
