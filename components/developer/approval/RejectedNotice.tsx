"use client"

import { CircleX, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MessageAdminButton, type ApprovalInfo } from "./MessageAdminButton"

/** Screen D (design 5D): the admin did not approve the request. */
export function RejectedNotice({
  reason,
  approval,
  code,
  onRequestAgain,
  disabled,
  retryAt,
}: {
  reason: string | null
  approval: ApprovalInfo | null
  code: string | null
  onRequestAgain?: () => void
  disabled?: boolean
  /** When a new request is allowed (access requests wait 24 h). */
  retryAt?: string | null
}) {
  const waiting = retryAt ? Date.parse(retryAt) > Date.now() : false
  return (
    <div className="space-y-2.5 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
      <p className="flex items-start gap-1.5 text-sm font-semibold text-foreground">
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 break-words">Request not approved{reason ? `: ${reason}` : ""}</span>
      </p>
      {waiting && retryAt && (
        <p className="text-xs text-muted-foreground">
          You can request again from {new Date(retryAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {onRequestAgain && (
          <Button size="sm" variant="outline" className="h-10 rounded-xl" disabled={disabled || waiting} onClick={onRequestAgain}>
            <RotateCw className="size-3.5" aria-hidden /> Request again
          </Button>
        )}
        <MessageAdminButton approval={approval} code={code} />
      </div>
    </div>
  )
}
