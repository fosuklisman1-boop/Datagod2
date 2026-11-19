"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, Plus, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useAdminProtected } from "@/hooks/use-admin"
import { adminFetch, ApiError, fetchRoles } from "./_lib/api"
import type { CreateRoleBody } from "./_lib/create-form"
import type { HubRole } from "./_lib/ladder-view"
import { CreateRoleDialog } from "./_components/CreateRoleDialog"
import { ReasonDialog } from "./_components/ReasonDialog"
import { RoleList } from "./_components/RoleList"

export default function AdminRolesPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [roles, setRoles] = useState<HubRole[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [cloneFrom, setCloneFrom] = useState<string | null>(null)
  const [moving, setMoving] = useState<{ role: HubRole; direction: "up" | "down" } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await fetchRoles()
      setRoles(data.roles)
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load roles"
      setLoadError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  const fail = async (e: unknown) => {
    toast.error(e instanceof Error ? e.message : "Request failed")
    // A stale ladder (409) is fixed by reloading, after the admin has seen the message.
    if (e instanceof ApiError && e.status === 409) await load()
  }

  const create = async (body: CreateRoleBody) => {
    if (busy) return
    setBusy(true)
    try {
      await adminFetch("/api/admin/roles", { method: "POST", body })
      toast.success("Role created")
      setCreateOpen(false)
      await load()
    } catch (e) {
      await fail(e)
    } finally {
      setBusy(false)
    }
  }

  const move = async (reason: string) => {
    if (busy || !moving) return
    setBusy(true)
    try {
      await adminFetch(`/api/admin/roles/${moving.role.id}/move`, {
        method: "POST",
        body: { direction: moving.direction, reason },
      })
      setMoving(null)
      await load()
    } catch (e) {
      setMoving(null)
      await fail(e)
    } finally {
      setBusy(false)
    }
  }

  if (adminLoading || !isAdmin) return null

  return (
    <DashboardLayout>
      <div className="bg-muted/40 p-4 md:p-8">
        <div className="mx-auto max-w-2xl lg:max-w-6xl">
          <div className="mb-6">
            <PageHeaderBanner title="Roles & Tiers" subtitle="Rank ladder, role prices, services and rights" />
          </div>
          <div className="mb-4 flex justify-end">
            <Button
              disabled={busy || !roles}
              onClick={() => {
                setCloneFrom(null)
                setCreateOpen(true)
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> New role
            </Button>
          </div>

          {loading && !roles ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : !roles ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-destructive">{loadError ?? "Failed to load"}</p>
                <Button variant="outline" onClick={load}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Retry
                </Button>
              </CardContent>
            </Card>
          ) : (
            <RoleList
              roles={roles}
              busy={busy}
              onMove={(role, direction) => setMoving({ role, direction })}
              onClone={(role) => {
                setCloneFrom(role.slug)
                setCreateOpen(true)
              }}
            />
          )}
        </div>
      </div>

      {roles ? (
        <CreateRoleDialog
          open={createOpen}
          roles={roles}
          cloneFrom={cloneFrom}
          busy={busy}
          onCancel={() => setCreateOpen(false)}
          onSubmit={create}
        />
      ) : null}
      <ReasonDialog
        open={moving !== null}
        title={moving ? `Move ${moving.role.name} ${moving.direction}` : "Move role"}
        description="Swaps its rank with the neighbouring role. This changes which prices it falls back to."
        confirmLabel="Move"
        busy={busy}
        onCancel={() => setMoving(null)}
        onConfirm={move}
      />
    </DashboardLayout>
  )
}
