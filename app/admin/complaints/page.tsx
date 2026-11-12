"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { SegmentedPillToggle } from "@/components/admin/segmented-pill-toggle"
import { ThreadsTab } from "@/components/admin/support/threads-tab"
import { LegacyTab } from "@/components/admin/support/legacy-tab"
import { useAdminProtected } from "@/hooks/use-admin"

export default function AdminSupportPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [tab, setTab] = useState<"threads" | "legacy">("threads")

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }
  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeaderBanner title="Support & Complaints" subtitle="Chat with customers and resolve their complaints">
          <SegmentedPillToggle
            options={[
              { label: "Threads", value: "threads" },
              { label: "Legacy", value: "legacy" },
            ]}
            value={tab}
            onChange={(v) => setTab(v === "legacy" ? "legacy" : "threads")}
          />
        </PageHeaderBanner>
        {tab === "threads" ? <ThreadsTab /> : <LegacyTab />}
      </div>
    </DashboardLayout>
  )
}
