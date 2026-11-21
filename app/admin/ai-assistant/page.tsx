"use client"

import { Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { parseTab, type ConsoleTab } from "@/lib/ai-console/engine"
import { SettingsTab } from "./_components/settings-tab"
import { KnowledgeTab } from "./_components/knowledge-tab"

const TAB_LABELS: Record<ConsoleTab, string> = {
  settings: "Settings", knowledge: "Knowledge", conversations: "Conversations", flags: "Flags",
}

function Placeholder({ name }: { name: string }) {
  return <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">{name}: coming next.</div>
}

function Console() {
  const tab = parseTab(useSearchParams().get("tab"))
  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 lg:px-8">
      <PageHeaderBanner
        title="AI Assistant"
        subtitle="Choose how the assistant sounds, which model answers, and who can use it."
      />
      <nav className="flex gap-1 overflow-x-auto border-b border-border" aria-label="AI Assistant sections">
        {(Object.keys(TAB_LABELS) as ConsoleTab[]).map((t) => (
          <Link
            key={t}
            href={`/admin/ai-assistant?tab=${t}`}
            replace
            aria-current={tab === t ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>
      {tab === "settings" && <SettingsTab />}
      {tab === "knowledge" && <KnowledgeTab />}
      {tab === "conversations" && <Placeholder name="Conversations" />}
      {tab === "flags" && <Placeholder name="Flags" />}
    </div>
  )
}

export default function AIAssistantPage() {
  return (
    <DashboardLayout>
      <Suspense fallback={null}>
        <Console />
      </Suspense>
    </DashboardLayout>
  )
}
