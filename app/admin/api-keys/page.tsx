"use client"

import { RefreshCw } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAdminProtected } from "@/hooks/use-admin"
import { ConsoleView } from "@/components/admin/api-keys/ConsoleView"
import { useConsoleData } from "@/components/admin/api-keys/use-console-data"

export default function AdminApiKeysPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const data = useConsoleData(isAdmin && !adminLoading)

  if (adminLoading || !isAdmin) {
    return (
      <DashboardLayout>
        <div className="flex h-full items-center justify-center">
          <RefreshCw className="size-8 animate-spin text-primary" aria-label="Loading" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <ConsoleView
        keys={data.keys}
        stats={data.stats}
        config={data.config}
        errors={data.errors}
        loading={data.loading}
        busy={data.busy}
        refresh={data.refresh}
        saveConfig={data.saveConfig}
        globalKill={data.globalKill}
        handlers={{
          approve: data.approve,
          revoke: data.revoke,
          saveLimits: data.saveLimits,
          resetLimits: data.resetLimits,
          v1Toggle: data.v1Toggle,
          v1Delete: data.v1Delete,
          v1SetRate: data.v1SetRate,
        }}
      />
    </DashboardLayout>
  )
}
