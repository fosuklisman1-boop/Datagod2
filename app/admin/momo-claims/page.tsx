"use client"

import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminProtected } from "@/hooks/use-admin"
import { adminErrorMessage } from "@/lib/momo-claim/admin-view"
import { adminFetch, ApiError, MOMO_API, type ListResponse } from "./_components/api"
import { EMPTY_FILTERS, MonitoringTab, type Filters } from "./_components/MonitoringTab"
import { ReconcileTab } from "./_components/ReconcileTab"
import { SessionsTab } from "./_components/SessionsTab"
import { SettingsTab } from "./_components/SettingsTab"

function queryString(f: Filters): string {
  const p = new URLSearchParams()
  if (f.status) p.set("status", f.status)
  if (f.network) p.set("network", f.network)
  if (f.q.trim()) p.set("q", f.q.trim())
  if (f.from) p.set("from", f.from)
  if (f.to) p.set("to", f.to)
  const s = p.toString()
  return s ? `${MOMO_API}?${s}` : MOMO_API
}

export default function MomoClaimsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [tab, setTab] = useState("monitoring")
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await adminFetch<ListResponse>(queryString(filters)))
    } catch (e) {
      setError(adminErrorMessage(e instanceof ApiError ? e.code : undefined))
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    if (isAdmin) void load()
  }, [isAdmin, load])

  if (adminLoading || !isAdmin) return null

  return (
    <DashboardLayout>
      <PageHeaderBanner title="MoMo Claims" subtitle="Forwarded MoMo payments, flags, sessions, statement checks and settings" />
      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
            <TabsTrigger value="sessions">Payment Sessions</TabsTrigger>
            <TabsTrigger value="reconcile">Reconciliation</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>

        <TabsContent value="monitoring" className="mt-4">
          <MonitoringTab
            data={data}
            loading={loading}
            error={error}
            filters={filters}
            onApply={setFilters}
            onChanged={(m) => {
              toast.success(m)
              void load()
            }}
          />
        </TabsContent>
        <TabsContent value="sessions" className="mt-4"><SessionsTab /></TabsContent>
        <TabsContent value="reconcile" className="mt-4"><ReconcileTab /></TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab settings={data?.settings ?? null} defaulted={data?.settingsDefaulted ?? true} onSaved={() => void load()} />
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  )
}
