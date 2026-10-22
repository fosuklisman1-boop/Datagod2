// components/developer/docs/Callout.tsx
import { AlertTriangle, Info } from "lucide-react"
import { cn } from "@/lib/utils"

const TONES = {
  info: {
    lead: "Note:",
    Icon: Info,
    box: "border-primary/25 bg-primary/[0.05] dark:border-primary/30 dark:bg-primary/10",
    icon: "bg-primary/10 text-primary dark:bg-primary/15",
    lead_cls: "text-primary",
  },
  warning: {
    lead: "Important:",
    Icon: AlertTriangle,
    box: "border-amber-400/70 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/40",
    icon: "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
    lead_cls: "text-amber-800 dark:text-amber-300",
  },
} as const

/** Info (navy) or warning (amber) callout. The title is rendered as an italic emphasis after "Note:"/"Important:". */
export function Callout({
  tone,
  title,
  children,
  className,
}: {
  tone: "info" | "warning"
  title?: string
  children: React.ReactNode
  className?: string
}) {
  const t = TONES[tone]
  return (
    <div role="note" className={cn("flex gap-3 rounded-xl border p-4 sm:gap-4 sm:p-5", t.box, className)}>
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", t.icon)} aria-hidden>
        <t.Icon className="size-[18px]" />
      </span>
      <div className="min-w-0 space-y-1 text-sm leading-6">
        <p className="text-foreground">
          <span className={cn("font-semibold", t.lead_cls)}>{t.lead}</span>{" "}
          {title ? <em className="font-medium text-foreground">{title}</em> : null}
        </p>
        <div className={cn(tone === "warning" ? "text-amber-950/80 dark:text-amber-100/85" : "text-muted-foreground")}>
          {children}
        </div>
      </div>
    </div>
  )
}
