"use client"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AlertTriangle, Ban, BadgeCheck } from "lucide-react"
import type { RiskFlag, UserSignalsView } from "@/lib/admin-users/risk-signals"

const FLAG_LABELS: Record<RiskFlag["code"], string> = {
  failed_orders: "Failed orders",
  refunds: "Refunds",
  admin_credit: "Admin credit",
  new_account_high_balance: "New account, high balance",
  shared_phone: "Shared phone",
}

/** One small warning icon per risk flag; the tooltip (and the screen-reader text) gives the reason. */
export function RiskFlagIcons({ flags, size = "sm" }: { flags: RiskFlag[]; size?: "sm" | "md" }) {
  if (!flags.length) return null
  const cls = size === "md" ? "w-4 h-4" : "w-3.5 h-3.5"
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${flags.length} risk flag(s)`}>
      {flags.map((f) => (
        <Tooltip key={f.code}>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex text-warning cursor-help rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <AlertTriangle className={cls} aria-hidden="true" />
              <span className="sr-only">{FLAG_LABELS[f.code]}: {f.reason}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="font-semibold">{FLAG_LABELS[f.code]}</p>
            <p>{f.reason}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  )
}

/** Phone verified / blacklisted markers next to a phone number. */
export function PhoneMarkers({ signals }: { signals: Pick<UserSignalsView, "phoneVerified" | "phoneBlacklisted"> | null | undefined }) {
  if (!signals) return null
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {signals.phoneVerified && (
        <span title="Phone verified" className="inline-flex text-success">
          <BadgeCheck className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="sr-only">Phone verified</span>
        </span>
      )}
      {signals.phoneBlacklisted && (
        <span title="Phone number is blacklisted" className="inline-flex text-destructive">
          <Ban className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="sr-only">Phone number is blacklisted</span>
        </span>
      )}
    </span>
  )
}

/** Small tag chips. */
export function TagChips({ tags, max = 3 }: { tags: string[]; max?: number }) {
  if (!tags.length) return null
  const shown = tags.slice(0, max)
  const rest = tags.length - shown.length
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((t) => (
        <span key={t} className={`rounded-full border px-1.5 py-0 text-[10px] leading-4 ${t === "fraud-watch" ? "border-destructive text-destructive" : "border-border text-muted-foreground"}`}>
          {t}
        </span>
      ))}
      {rest > 0 && <span className="text-[10px] leading-4 text-muted-foreground" title={tags.slice(max).join(", ")}>+{rest}</span>}
    </span>
  )
}
