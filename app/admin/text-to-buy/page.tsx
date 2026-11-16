"use client"

import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAdminProtected } from "@/hooks/use-admin"
import { adminFetch, ApiError, TTB_API, type OverviewResponse } from "./_components/api"
import { ttbErrorMessage } from "./_components/format"
import { MessagesTab } from "./_components/MessagesTab"
import { OverviewTab } from "./_components/OverviewTab"
import { SettingsTab } from "./_components/SettingsTab"
import { TryItTab } from "./_components/TryItTab"

export default function TextToBuyPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [tab, setTab] = useState("overview")
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await adminFetch<OverviewResponse>(TTB_API))
    } catch (e) {
      setError(ttbErrorMessage(e instanceof ApiError ? e.code : undefined))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) void load()
  }, [isAdmin, load])

  if (adminLoading || !isAdmin) return null

  return (
    <DashboardLayout>
      <PageHeaderBanner title="Text-to-Buy" subtitle="Customers text an order and pay with a MoMo prompt" />
      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
            <TabsTrigger value="try">Try it</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab data={data} error={error} onChanged={() => void load()} />
        </TabsContent>
        <TabsContent value="messages" className="mt-4"><MessagesTab /></TabsContent>
        <TabsContent value="try" className="mt-4"><TryItTab /></TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab settings={data?.settings ?? null} defaulted={data?.settingsDefaulted ?? true} onSaved={() => void load()} />
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  )
}
