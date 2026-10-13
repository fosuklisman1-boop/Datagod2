import Link from "next/link"
import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { costSummary } from "../../_lib/view"

interface Props {
  chars: number
  segPerRecipient: number
  estRecipients: number
  hasGroup: boolean
  balance: number
}

export function CostSummary({ chars, segPerRecipient, estRecipients, hasGroup, balance }: Props) {
  const cost = costSummary(estRecipients, segPerRecipient, balance)
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{chars} chars · {segPerRecipient} SMS</span>
        <span className="font-medium text-primary">{segPerRecipient} credit{segPerRecipient === 1 ? "" : "s"} per recipient</span>
      </div>

      {cost.overBudget && (
        <Alert variant={hasGroup ? "default" : "destructive"}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {hasGroup
              ? `Estimated ~${cost.total} credits vs your ${balance}. Opted-out numbers are skipped, so it may still fit — if it doesn't, the whole send is rejected (no partial send). `
              : `This send needs about ${cost.total} credits but you have ${balance} (short by ${cost.short}). `}
            <Link href="/dashboard/sms/credits" className="font-medium underline">Buy credits</Link>
          </AlertDescription>
        </Alert>
      )}

      {estRecipients > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          {hasGroup
            ? `Approx. ${estRecipients} recipient${estRecipients === 1 ? "" : "s"} (group is an estimate; opted-out numbers are skipped server-side).`
            : `${estRecipients} recipient${estRecipients === 1 ? "" : "s"}.`}
          {` Estimated cost: ${cost.total} credit${cost.total === 1 ? "" : "s"}.`}
        </p>
      )}
    </div>
  )
}
