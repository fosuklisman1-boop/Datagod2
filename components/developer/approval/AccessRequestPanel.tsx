"use client"

import { KeyRound, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MessageAdminButton, RequestCode, type ApprovalInfo } from "./MessageAdminButton"
import { RejectedNotice } from "./RejectedNotice"

export interface AccessRequestView {
  code: string
  status: "pending" | "rejected"
  reason: string | null
  retryAt: string | null
}

/**
 * Screen B (design 5B), for accounts whose role cannot use the API. Two steps on purpose: the request is created
 * first, and only then is the WhatsApp link shown (a window opened after an awaited request is blocked as a pop-up).
 */
export function AccessRequestPanel({
  request,
  approval,
  busy,
  onRequest,
  onCancel,
}: {
  request: AccessRequestView | null
  approval: ApprovalInfo | null
  busy: boolean
  onRequest: () => void
  onCancel: () => void
}) {
  if (request?.status === "rejected") {
    return (
      <section className="rounded-2xl border border-white/60 bg-card p-4 clay dark:border-white/5 sm:p-5">
        <RejectedNotice reason={request.reason} approval={approval} code={request.code} retryAt={request.retryAt} onRequestAgain={onRequest} disabled={busy} />
      </section>
    )
  }

  if (request?.status === "pending") {
    return (
      <section className="space-y-3 rounded-2xl border border-white/60 bg-card p-4 clay dark:border-white/5 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-bold text-foreground">Access requested</h3>
          <RequestCode code={request.code} />
        </div>
        <p className="text-sm leading-6 text-muted-foreground">Contact the admin for approval. Once approved you can create API keys here.</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <MessageAdminButton approval={approval} code={request.code} />
          <Button variant="ghost" className="h-10 rounded-xl text-muted-foreground" disabled={busy} onClick={onCancel}>
            Cancel request
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-3 rounded-2xl border border-white/60 bg-card p-4 clay dark:border-white/5 sm:p-5">
      <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
        <KeyRound className="size-5 text-primary" aria-hidden /> API access needs admin approval
      </h3>
      <p className="text-sm leading-6 text-muted-foreground">
        Your account type doesn&apos;t include the Developer API. Ask for access and message the admin with your request code.
      </p>
      <Button className="h-10 rounded-xl px-5" disabled={busy} onClick={onRequest}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />} Request API access
      </Button>
    </section>
  )
}
