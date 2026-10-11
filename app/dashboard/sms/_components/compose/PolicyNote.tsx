import Link from "next/link"
import { ShieldQuestion } from "lucide-react"
import type { PolicyPreview } from "./usePolicyPreview"

/** Non-blocking amber advisory. Shown only when the draft would not be allowed. */
export function PolicyNote({ preview }: { preview: PolicyPreview | null }) {
  const show = !!preview && preview.decision !== "allow" && preview.decision !== "unavailable" && !preview.unavailable && !!preview.reason
  const lead = preview?.decision === "hold"
    ? "This send would be held for a quick review before it goes out:"
    : "When rules are enforced this message would be stopped:"
  return (
    <div className="space-y-2">
      {show && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800">
          <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{lead} {preview!.reason}</p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Messages are checked against our sending rules. Need a verified sender name or higher limits?{" "}
        <Link href="/dashboard/sms/business" className="font-medium text-primary hover:underline">Business &amp; Sender ID</Link>
      </p>
    </div>
  )
}
