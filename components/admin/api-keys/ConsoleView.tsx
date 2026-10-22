"use client"

import { useState } from "react"
import { KeyRound, RefreshCw, ScrollText } from "lucide-react"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { cn } from "@/lib/utils"
import { statusCounts, type ConsoleKey } from "@/lib/api-v2/admin-view"
import type { AdminStats, KeyActivity } from "@/lib/api-v2/admin-stats"
import type { ApiConfig, SourceErrors } from "./use-console-data"
import type { KeyRowHandlers } from "./KeyRow"
import type { LogRow } from "./LogTable"
import { OverviewTiles } from "./OverviewTiles"
import { FeatureControls } from "./FeatureControls"
import { KeyList } from "./KeyList"
import { RequestLogs } from "./RequestLogs"
import { Segmented } from "./ui"

export interface ConsoleViewProps {
  keys: ConsoleKey[]
  stats: AdminStats | null
  config: ApiConfig | null
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
    tab?: "keys" | "logs"
  }
}

export function ConsoleView(p: ConsoleViewProps) {
  const [tab, setTab] = useState<"keys" | "logs">(p.preview?.tab ?? "keys")
  const pending = statusCounts(p.keys).pending
  const sourceErrors = [
    p.errors.v2 && `v2 keys could not be loaded: ${p.errors.v2}`,
    p.errors.v1 && `Legacy v1 keys could not be loaded: ${p.errors.v1}`,
  ].filter((e): e is string => !!e)

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6">
      <PageHeaderBanner title="API Key Management" subtitle="Approve, revoke, and set per-key rate limits">
        <button
          type="button"
          onClick={() => void p.refresh()}
          disabled={p.loading}
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-3.5 text-sm font-semibold text-white transition-colors hover:bg-white/20 disabled:opacity-70"
        >
          <RefreshCw className={cn("size-4", p.loading && "animate-spin")} aria-hidden />
          Refresh
        </button>
      </PageHeaderBanner>

      <OverviewTiles keys={p.keys} stats={p.stats} statsError={p.errors.stats} loading={p.loading} onRetry={() => void p.refresh()} />

      <FeatureControls
        config={p.config}
        error={p.errors.config}
        onSave={p.saveConfig}
        onRetry={() => void p.refresh()}
        onGlobalKill={p.globalKill}
      />

      <Segmented<"keys" | "logs">
        label="Console section"
        value={tab}
        onChange={setTab}
        className="w-full sm:w-auto"
        options={[
          {
            value: "keys",
            label: (
              <>
                <KeyRound className="size-4" aria-hidden />
                API Keys
                {pending > 0 && (
                  <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-bold leading-5 text-white">{pending}</span>
                )}
              </>
            ),
          },
          {
            value: "logs",
            label: (
              <>
                <ScrollText className="size-4" aria-hidden />
                Request Logs
              </>
            ),
          },
        ]}
      />

      {tab === "keys" ? (
        <KeyList
          keys={p.keys}
          busy={p.busy}
          handlers={p.handlers}
          loading={p.loading}
          sourceErrors={sourceErrors}
          onRetry={() => void p.refresh()}
          previewOpen={p.preview?.open}
          previewActivity={p.preview?.activity}
        />
      ) : (
        <RequestLogs keys={p.keys} preset={p.preview?.logs} />
      )}
    </div>
  )
}
