"use client"

import { Activity, Archive, BarChart3, Inbox, KeyRound, LayoutDashboard, Megaphone, ScrollText, Users } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { CONSOLE_TABS, type ConsoleTab } from "@/lib/api-v2/console-tabs"
import { Segmented } from "./ui"

const ICONS: Record<ConsoleTab, LucideIcon> = {
  overview: LayoutDashboard,
  approvals: Inbox,
  developers: Users,
  keys: KeyRound,
  logs: ScrollText,
  services: Activity,
  announcements: Megaphone,
  report: BarChart3,
  legacy: Archive,
}

function Badge({ n }: { n: number }) {
  return <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-bold leading-5 text-white">{n}</span>
}

/** The nine console tabs. Wraps onto more rows on a phone instead of scrolling sideways. */
export function ConsoleTabBar({
  value,
  onChange,
  approvals,
  pendingKeys,
}: {
  value: ConsoleTab
  onChange: (t: ConsoleTab) => void
  approvals: number | null
  pendingKeys: number
}) {
  return (
    <Segmented<ConsoleTab>
      label="Console section"
      value={value}
      onChange={onChange}
      className="flex w-full flex-wrap gap-1"
      options={CONSOLE_TABS.map(({ id, label }) => {
        const Icon = ICONS[id]
        return {
          value: id,
          label: (
            <>
              <Icon className="size-4" aria-hidden />
              {label}
              {id === "approvals" && (approvals ?? 0) > 0 && <Badge n={approvals ?? 0} />}
              {id === "keys" && pendingKeys > 0 && <Badge n={pendingKeys} />}
            </>
          ),
        }
      })}
    />
  )
}
