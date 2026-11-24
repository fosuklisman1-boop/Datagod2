"use client"

import { Archive } from "lucide-react"
import type { ConsoleKey } from "@/lib/api-v2/admin-view"
import type { KeyRowHandlers } from "./KeyRow"
import { KeyList } from "./KeyList"
import { V1RetirementCard } from "./V1RetirementCard"
import { Eyebrow, IconChip, Panel } from "./ui"

/** Legacy v1: the retirement card and the v1 keys with their controls. Behaviour unchanged until the sunset. */
export function LegacyTab(p: { keys: ConsoleKey[]; busy: Record<string, boolean>; handlers: KeyRowHandlers; loading: boolean; sourceErrors: string[]; onRetry: () => void }) {
  return (
    <div className="space-y-5">
      <Panel className="flex items-start gap-3">
        <IconChip icon={Archive} tone="amber" />
        <div className="min-w-0">
          <Eyebrow>Legacy</Eyebrow>
          <h2 className="text-base font-bold text-foreground">Legacy API v1, ends 30 Nov 2026</h2>
          <p className="text-sm text-muted-foreground">Everything here works as before until the sunset. New developers use v2.</p>
        </div>
      </Panel>
      <V1RetirementCard />
      <KeyList keys={p.keys} source="v1" busy={p.busy} handlers={p.handlers} loading={p.loading} sourceErrors={p.sourceErrors} onRetry={p.onRetry} />
    </div>
  )
}
