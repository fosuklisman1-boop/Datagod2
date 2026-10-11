import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { isInFlight, logStatus, toneBadgeClass } from "../../_lib/view"

export function StatusBadge({ status }: { status: string }) {
  const s = logStatus(status)
  return (
    <Badge variant="outline" className={toneBadgeClass(s.tone)}>
      {isInFlight(status) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {s.label}
    </Badge>
  )
}
