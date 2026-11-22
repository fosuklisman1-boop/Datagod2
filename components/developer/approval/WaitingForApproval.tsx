"use client"

import { Hourglass } from "lucide-react"
import { MessageAdminButton, RequestCode, type ApprovalInfo } from "./MessageAdminButton"

/** Screen A (design 5A): a live key, or its replacement, waiting for the admin. */
export function WaitingForApproval({
  code,
  approval,
  replacement = false,
}: {
  code: string | null
  approval: ApprovalInfo | null
  /** True when an active key keeps working meanwhile (a swap). */
  replacement?: boolean
}) {
  return (
    <div className="space-y-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <Hourglass className="size-4" aria-hidden /> Waiting for approval
        </p>
        <RequestCode code={code} />
      </div>
      <p className="text-xs leading-5">
        {replacement
          ? "Your current live key keeps working until an admin approves this new one."
          : "This key can't make requests until an admin approves it."}{" "}
        Contact the admin for approval.
      </p>
      <MessageAdminButton approval={approval} code={code} className="w-full sm:w-auto" />
    </div>
  )
}
