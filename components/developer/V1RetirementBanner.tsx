import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { bannerKind, bannerText } from "@/lib/api-v1/retirement-ui"

/** Retirement notice for users with an active v1 key. Renders nothing when no sunset is set or there is no active key. */
export function V1RetirementBanner({
  sunsetAt,
  exempt,
  hasActiveKey,
  v2Open = true,
  now,
}: {
  sunsetAt: string | null
  exempt: boolean
  hasActiveKey: boolean
  /** Whether the v2 key section is available to this user (changes the call to action). */
  v2Open?: boolean
  now?: Date
}) {
  const kind = bannerKind({ sunsetAt, exempt, hasActiveKey })
  if (kind === "none" || !sunsetAt) return null
  return (
    <div
      role="status"
      data-variant={kind}
      className="flex items-start gap-3 rounded-2xl border border-[#1b388b]/30 bg-[#1b388b]/5 p-4 text-sm text-foreground"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#1b388b]" aria-hidden />
      <p className="min-w-0 leading-6">
        {bannerText(kind, sunsetAt, { now, v2Open })}{" "}
        <Link href="/developers" className="font-semibold text-primary underline underline-offset-2">
          View the v2 docs
        </Link>
      </p>
    </div>
  )
}
