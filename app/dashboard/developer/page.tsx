// app/dashboard/developer/page.tsx
"use client"

import { useEffect, useState } from "react"
import { BookOpen, KeyRound } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DocsPage } from "@/components/developer/docs/DocsPage"
import { InlineCode } from "@/components/developer/docs/RichText"
import { V2KeysPanel } from "@/components/developer/V2KeysPanel"
import { LegacyV1Section } from "@/components/developer/LegacyV1Section"
import { v2DocsRegistry, V2_BASE_URL } from "@/lib/api-v2/docs/registry"

const PAGE_TABS = [
  { id: "keys", label: "API Keys", icon: KeyRound },
  { id: "docs", label: "Documentation", icon: BookOpen },
] as const

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

export default function DeveloperPage() {
  const stickyTop = useHeaderOffset()

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl space-y-5 lg:max-w-6xl">
        <DashboardHeroBanner
          title="Developer API"
          subtitle="Generate API keys and connect your apps to Datagod with the v2 API."
          icon={KeyRound}
        />

        <p className="px-1 text-sm leading-6 text-muted-foreground">
          Base URL <InlineCode>{V2_BASE_URL}</InlineCode>. Authenticate every request with one of your keys below; responses are JSON.
        </p>

        <Tabs defaultValue="keys">
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

          <TabsContent value="keys" className="mt-4">
            <V2KeysPanel />
          </TabsContent>

          <TabsContent value="docs" className="mt-4">
            <DocsPage sections={v2DocsRegistry} compact stickyTop={stickyTop} />
          </TabsContent>
        </Tabs>

        <LegacyV1Section />
      </div>
    </DashboardLayout>
  )
}
