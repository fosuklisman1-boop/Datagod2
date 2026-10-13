import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { isCancelledLog, isInFlight, logStatus, toneBadgeClass } from "../../_lib/view"

/** `cancelled` = the read model's derived flag for a customer-cancelled scheduled send (stored as failed). */
export function StatusBadge({ status, cancelled }: { status: string; cancelled?: boolean | null }) {
  const s = isCancelledLog({ status, cancelled }) ? { label: "Cancelled", tone: "muted" as const } : logStatus(status)
  return (
    <Badge variant="outline" className={toneBadgeClass(s.tone)}>
      {isInFlight(status) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {s.label}
    </Badge>
  )
}
