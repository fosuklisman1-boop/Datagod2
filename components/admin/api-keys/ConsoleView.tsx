"use client"

import { useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { initialConsoleTab, type ConsoleTab } from "@/lib/api-v2/console-tabs"
import { ApprovalsPanel, useApprovalCount } from "./approvals/ApprovalsPanel"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { cn } from "@/lib/utils"
import { statusCounts, type ConsoleKey } from "@/lib/api-v2/admin-view"
import type { AdminStats, KeyActivity } from "@/lib/api-v2/admin-stats"
import type { ApiConfig, RoleOption, SourceErrors } from "./use-console-data"
import type { KeyRowHandlers } from "./KeyRow"
import type { LogRow } from "./LogTable"
import { KeyList } from "./KeyList"
import { RequestLogs } from "./RequestLogs"
import { ConsoleTabBar } from "./ConsoleTabBar"
import { OverviewTab } from "./OverviewTab"
import { LegacyTab } from "./LegacyTab"
import { DevelopersTab } from "./DevelopersTab"
import { ServicesTab } from "./ServicesTab"
import { AnnouncementsTab } from "./AnnouncementsTab"
import { ReportTab } from "./ReportTab"

export interface ConsoleViewProps {
  keys: ConsoleKey[]
  stats: AdminStats | null
  config: ApiConfig | null
  /** Active roles for the allowed-roles control; null/absent when the list could not be loaded. */
  roles?: RoleOption[] | null
  errors: SourceErrors
  loading: boolean
  busy: Record<string, boolean>
  handlers: KeyRowHandlers
  refresh: () => Promise<void>
  saveConfig: (next: ApiConfig) => Promise<boolean>
  globalKill: () => Promise<void>
  /** Preview-only seams (the dev preview renders without network). */
  preview?: {
    open?: Record<string, { activity?: boolean; limits?: boolean }>
    activity?: Record<string, KeyActivity>
    logs?: { rows: LogRow[]; total: number }
    tab?: ConsoleTab
  }
}


export function ConsoleView(p: ConsoleViewProps) {
  const [tab, setTab] = useState<ConsoleTab>(p.preview?.tab ?? "overview")
  const pending = statusCounts(p.keys.filter((k) => k.source === "v2")).pending
  const approvals = useApprovalCount()
  // The first tab: ?tab= (e.g. from an alert link), else Approvals while anything waits, else Overview. Chosen once.
  const chosen = useRef(Boolean(p.preview?.tab))
  useEffect(() => {
    if (chosen.current || approvals.count === null) return
    chosen.current = true
    const requested = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab")
    setTab(initialConsoleTab({ requested, waiting: approvals.count }))
  }, [approvals.count])
  const pickTab = (t: ConsoleTab) => {
    chosen.current = true
    setTab(t)
  }
  const sourceErrors = (source: "v1" | "v2") =>
    [source === "v2" && p.errors.v2 && `v2 keys could not be loaded: ${p.errors.v2}`, source === "v1" && p.errors.v1 && `Legacy v1 keys could not be loaded: ${p.errors.v1}`].filter(
      (e): e is string => !!e,
    )
  const retry = () => void p.refresh()

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6">
      <PageHeaderBanner title="API Console" subtitle="Developers, keys, services, announcements and the business report">
        <button
          type="button"
          onClick={retry}
          disabled={p.loading}
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-3.5 text-sm font-semibold text-white transition-colors hover:bg-white/20 disabled:opacity-70"
        >
          <RefreshCw className={cn("size-4", p.loading && "animate-spin")} aria-hidden />
          Refresh
        </button>
      </PageHeaderBanner>

      <ConsoleTabBar value={tab} onChange={pickTab} approvals={approvals.count} pendingKeys={pending} />

      {/* Each tab mounts (and loads its own data) only when it is open. */}
      {tab === "overview" && (
        <OverviewTab
          keys={p.keys}
          stats={p.stats}
          config={p.config}
          roles={p.roles ?? null}
          errors={p.errors}
          loading={p.loading}
          onRetry={retry}
          saveConfig={p.saveConfig}
          globalKill={p.globalKill}
        />
      )}
      {tab === "approvals" && (
        <ApprovalsPanel
          onChanged={() => {
            void approvals.refresh()
            void p.refresh()
          }}
        />
      )}
      {tab === "developers" && <DevelopersTab />}
      {tab === "keys" && (
        <KeyList
          keys={p.keys}
          source="v2"
          busy={p.busy}
          handlers={p.handlers}
          loading={p.loading}
          sourceErrors={sourceErrors("v2")}
          onRetry={retry}
          previewOpen={p.preview?.open}
          previewActivity={p.preview?.activity}
        />
      )}
      {tab === "logs" && <RequestLogs keys={p.keys} preset={p.preview?.logs} />}
      {tab === "services" && <ServicesTab />}
      {tab === "announcements" && <AnnouncementsTab />}
      {tab === "report" && <ReportTab />}
      {tab === "legacy" && <LegacyTab keys={p.keys} busy={p.busy} handlers={p.handlers} loading={p.loading} sourceErrors={sourceErrors("v1")} onRetry={retry} />}
    </div>
  )
}
