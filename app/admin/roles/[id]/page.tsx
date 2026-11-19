"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminProtected } from "@/hooks/use-admin"
import { ApiError, fetchRoles } from "../_lib/api"
import type { HubRole } from "../_lib/ladder-view"
import { AuditTab } from "../_components/AuditTab"
import { BasicsTab } from "../_components/BasicsTab"
import { RoleBadge } from "../_components/RoleBadge"
import { ThemeTab } from "../_components/ThemeTab"

const PLACEHOLDER_TABS = [
  { value: "prices", label: "Prices" },
  { value: "services", label: "Services" },
  { value: "rights", label: "Rights" },
  { value: "members", label: "Members" },
] as const

export default function AdminRoleEditorPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const params = useParams<{ id: string }>()
  const id = params?.id
  const [role, setRole] = useState<HubRole | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await fetchRoles()
      const found = data.roles.find((r) => r.id === id) ?? null
      if (!found) throw new Error("Role not found")
      setRole(found)
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load role"
      setLoadError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  const onError = async (e: unknown) => {
    toast.error(e instanceof Error ? e.message : "Request failed")
    if (e instanceof ApiError && e.status === 409) await load()
  }

  if (adminLoading || !isAdmin) return null

  return (
    <DashboardLayout>
      <div className="bg-muted/40 p-4 md:p-8">
        <div className="mx-auto max-w-2xl lg:max-w-6xl">
          <div className="mb-4">
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/roles">
                <ArrowLeft className="mr-1 h-4 w-4" /> All roles
              </Link>
            </Button>
          </div>
          <div className="mb-6">
            <PageHeaderBanner title={role ? role.name : "Role"} subtitle="Edit a role's look, prices, services and rights" />
          </div>

          {loading && !role ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : !role ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-destructive">{loadError ?? "Failed to load"}</p>
                <Button variant="outline" onClick={load}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Retry
                </Button>
              </CardContent>
            </Card>
          ) : role.slug === "admin" ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                The admin role is read-only.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="mb-4 flex items-center gap-2">
                <RoleBadge name={role.name} color={role.badge_color} icon={role.icon} />
                {role.archived_at ? <span className="text-xs text-muted-foreground">Archived</span> : null}
              </div>
              <Tabs defaultValue="basics">
                <div className="overflow-x-auto">
                  <TabsList>
                    <TabsTrigger value="basics">Basics</TabsTrigger>
                    <TabsTrigger value="prices">Prices</TabsTrigger>
                    <TabsTrigger value="services">Services</TabsTrigger>
                    <TabsTrigger value="rights">Rights</TabsTrigger>
                    <TabsTrigger value="theme">Theme</TabsTrigger>
                    <TabsTrigger value="members">Members</TabsTrigger>
                    <TabsTrigger value="audit">Audit</TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent value="basics" className="mt-4">
                  <BasicsTab role={role} onChanged={load} busy={busy} setBusy={setBusy} onError={onError} />
                </TabsContent>
                {PLACEHOLDER_TABS.map((t) => (
                  <TabsContent key={t.value} value={t.value} className="mt-4">
                    <Card>
                      <CardContent className="py-10 text-center text-sm text-muted-foreground">
                        Coming in the next step
                      </CardContent>
                    </Card>
                  </TabsContent>
                ))}
                <TabsContent value="theme" className="mt-4">
                  <ThemeTab role={role} onChanged={load} busy={busy} setBusy={setBusy} onError={onError} />
                </TabsContent>
                <TabsContent value="audit" className="mt-4">
                  <AuditTab roleId={role.id} />
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
