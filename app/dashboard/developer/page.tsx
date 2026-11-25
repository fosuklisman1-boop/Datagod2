// app/dashboard/developer/page.tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import { Activity, BarChart3, BookOpen, KeyRound, PackageSearch, ScrollText } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DocsPage } from "@/components/developer/docs/DocsPage"
import { PostmanButtons } from "@/components/developer/docs/PostmanButtons"
import { InlineCode } from "@/components/developer/docs/RichText"
import { V2KeysPanel } from "@/components/developer/V2KeysPanel"
import { AnnouncementBanner } from "@/components/developer/AnnouncementBanner"
import { OverviewTab } from "@/components/developer/dashboard/OverviewTab"
import { UsageTab } from "@/components/developer/dashboard/UsageTab"
import { LogsTab } from "@/components/developer/dashboard/LogsTab"
import { OrdersTab } from "@/components/developer/dashboard/OrdersTab"
import { v2DocsRegistry, V2_BASE_URL } from "@/lib/api-v2/docs/registry"
import { parseTab, type DashTab } from "@/lib/api-v2/dev-dashboard-view"

const PAGE_TABS: { id: DashTab; label: string; icon: typeof KeyRound }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "keys", label: "API Keys", icon: KeyRound },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "orders", label: "Orders", icon: PackageSearch },
  { id: "docs", label: "Documentation", icon: BookOpen },
]

/**
 * The dashboard header (components/layout/header.tsx) is fixed: 0.5rem top padding plus h-14 (md: h-16),
 * i.e. 64px / 72px, and <main> scrolls beneath it. The docs' sticky SECTION bar and side nav sit 8px
 * below it. (iOS safe-area inset is not included; the bar then tucks slightly under the notch header.)
 */
function useHeaderOffset(): number {
  const [offset, setOffset] = useState(72)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)")
    const update = () => setOffset(mq.matches ? 80 : 72)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])
  return offset
}

/** The open tab lives in ?tab= so a link or a refresh lands on the same tab. */
function useTab(): [DashTab, (t: DashTab) => void] {
  const [tab, setTabState] = useState<DashTab>("overview")
  useEffect(() => {
    setTabState(parseTab(new URLSearchParams(window.location.search).get("tab")))
  }, [])
  const setTab = useCallback((t: DashTab) => {
    setTabState(t)
    const url = new URL(window.location.href)
    if (t === "overview") url.searchParams.delete("tab")
    else url.searchParams.set("tab", t)
    window.history.replaceState(null, "", url.toString())
  }, [])
  return [tab, setTab]
}

export default function DeveloperPage() {
  const stickyTop = useHeaderOffset()
  const [tab, setTab] = useTab()

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl space-y-5 lg:max-w-6xl">
        <DashboardHeroBanner
          title="Developer API"
          subtitle="Keys, usage, request logs and orders for your Datagod API integration."
          icon={KeyRound}
        />
        <AnnouncementBanner />

        <p className="px-1 text-sm leading-6 text-muted-foreground">
          Base URL <InlineCode>{V2_BASE_URL}</InlineCode>. Authenticate every request with one of your keys; responses are JSON.
        </p>

        <Tabs value={tab} onValueChange={(v) => setTab(parseTab(v))}>
          <div className="-mx-2 overflow-x-auto px-2 sm:mx-0 sm:px-0">
            <TabsList className="inline-flex min-w-full gap-1 rounded-2xl bg-muted p-1 h-auto sm:min-w-0">
              {PAGE_TABS.map(({ id, label, icon: Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-bold data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                >
                  <Icon className="h-4 w-4" aria-hidden /> {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-4">
            {tab === "overview" && <OverviewTab onOpenTab={setTab} />}
          </TabsContent>
          <TabsContent value="keys" className="mt-4">
            <V2KeysPanel />
          </TabsContent>
          <TabsContent value="usage" className="mt-4">
            {tab === "usage" && <UsageTab />}
          </TabsContent>
          <TabsContent value="logs" className="mt-4">
            {tab === "logs" && <LogsTab />}
          </TabsContent>
          <TabsContent value="orders" className="mt-4">
            {tab === "orders" && <OrdersTab />}
          </TabsContent>
          <TabsContent value="docs" className="mt-4">
            <DocsPage sections={v2DocsRegistry} compact stickyTop={stickyTop} top={<PostmanButtons />} />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
