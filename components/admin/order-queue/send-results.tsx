"use client"

import { CheckCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { rejectReasonLabel } from "@/lib/order-queue/confirm-summary"

export type SendResultData = {
  supplierLabel: string
  queued: string[]
  /** Server rejections plus rows the preview kept back before sending. */
  rejected: { id: string; reason: string }[]
  risky: string[]
}

const shortId = (id: string) => id.slice(0, 8)

/** What happened to the last "Send to supplier": queued ids and rejected ids with readable reasons. */
export function SendResults({ result, onDismiss }: { result: SendResultData; onDismiss: () => void }) {
  return (
    <Card data-testid="send-results" className="border-primary/30">
      <CardContent className="space-y-3 pt-4 pb-3 text-sm">
        <div className="flex items-start justify-between gap-2">
          <p className="flex items-center gap-2 font-semibold">
            <CheckCircle className="h-4 w-4 shrink-0 text-success" />
            <span data-field="queued-count">
              {result.queued.length} queued to {result.supplierLabel}
              {result.rejected.length > 0 ? ` · ${result.rejected.length} not sent` : ""}
            </span>
          </p>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onDismiss} aria-label="Dismiss send results">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {result.queued.length > 0 && (
            <div data-section="queued">
              <p className="text-xs font-medium text-muted-foreground">Queued</p>
              <ul className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                {result.queued.map((id) => (
                  <li key={id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {shortId(id)}
                    {result.risky.includes(id) ? " (held/reversed)" : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.rejected.length > 0 && (
            <div data-section="rejected">
              <p className="text-xs font-medium text-muted-foreground">Not sent</p>
              <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-xs">
                {result.rejected.map((r, i) => (
                  <li key={`${r.id}-${i}`} className="break-words">
                    <span className="font-mono">{shortId(r.id)}</span> — {rejectReasonLabel(r.reason)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
