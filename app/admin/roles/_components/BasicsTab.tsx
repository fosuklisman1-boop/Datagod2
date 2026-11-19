"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { adminFetch } from "../_lib/api"
import type { HubRole } from "../_lib/ladder-view"
import { ReasonDialog } from "./ReasonDialog"

interface Props {
  role: HubRole
  /** Reload the list after a successful write. */
  onChanged: () => Promise<void> | void
  /** Shared in-flight flag so no two writes overlap. */
  busy: boolean
  setBusy: (b: boolean) => void
  /** Called with the failure so the page can reload on a 409. */
  onError: (e: unknown) => Promise<void> | void
}

export function BasicsTab({ role, onChanged, busy, setBusy, onError }: Props) {
  const [name, setName] = useState(role.name)
  const [description, setDescription] = useState(role.description ?? "")
  const [archiving, setArchiving] = useState(false)

  useEffect(() => {
    setName(role.name)
    setDescription(role.description ?? "")
  }, [role.id, role.name, role.description])

  const archived = !!role.archived_at
  const dirty = name.trim() !== role.name || description.trim() !== (role.description ?? "")

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      // No reason is sent: the server records "basics edit".
      await adminFetch(`/api/admin/roles/${role.id}`, {
        method: "PATCH",
        body: { name: name.trim(), description: description.trim() === "" ? null : description.trim() },
      })
      toast.success("Saved")
      await onChanged()
    } catch (e) {
      await onError(e)
    } finally {
      setBusy(false)
    }
  }

  const archive = async (reason: string) => {
    if (busy) return
    setBusy(true)
    try {
      await adminFetch(`/api/admin/roles/${role.id}/archive`, { method: "POST", body: { reason } })
      toast.success("Role archived")
      setArchiving(false)
      await onChanged()
    } catch (e) {
      setArchiving(false)
      await onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>Slug</Label>
            <p className="text-sm text-muted-foreground">{role.slug} (cannot be changed)</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="basics-name">Name</Label>
            <Input id="basics-name" value={name} maxLength={40} disabled={archived} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="basics-desc">Description</Label>
            <Input
              id="basics-desc"
              value={description}
              maxLength={200}
              disabled={archived}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <Button onClick={save} disabled={busy || archived || !dirty}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </CardContent>
      </Card>

      {!role.is_system && !archived ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Archive role</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Archiving retires the role and its slug. Roles with members cannot be archived: move the members first.
              Currently {role.member_count} member{role.member_count === 1 ? "" : "s"}.
            </p>
            <Button variant="destructive" disabled={busy} onClick={() => setArchiving(true)}>
              Archive role
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <ReasonDialog
        open={archiving}
        title={`Archive ${role.name}?`}
        description="The role leaves the ladder and can no longer be assigned."
        confirmLabel="Archive"
        destructive
        busy={busy}
        onCancel={() => setArchiving(false)}
        onConfirm={archive}
      />
    </div>
  )
}
