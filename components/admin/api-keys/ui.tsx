import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { KeyStatus } from "@/lib/api-v2/keys"

export type Tone = "primary" | "amber" | "green" | "red" | "slate"

export const TONE_CHIP: Record<Tone, string> = {
  primary: "bg-primary/10 text-primary dark:bg-primary/15",
  amber: "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
  green: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  red: "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400",
  slate: "bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300",
}

export function IconChip({ icon: Icon, tone = "primary", className }: { icon: LucideIcon; tone?: Tone; className?: string }) {
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", TONE_CHIP[tone], className)} aria-hidden>
      <Icon className="size-[18px]" />
    </span>
  )
}

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground", className)}>{children}</p>
  )
}

/** Card surface used across the console (mirrors the docs kit's bordered panels). */
export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5 dark:bg-white/[0.03]", className)}>
      {children}
    </section>
  )
}

const STATUS_CLS: Record<KeyStatus, string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  revoked: "border-rose-500/30 bg-rose-500/[0.07] text-rose-700/90 dark:text-rose-300/90",
}

const STATUS_DOT: Record<KeyStatus, string> = {
  pending: "bg-amber-500",
  active: "bg-emerald-500",
  revoked: "bg-rose-500",
}

export function StatusBadge({ status, label }: { status: KeyStatus; label?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold", STATUS_CLS[status])}>
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} aria-hidden />
      {label ?? status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { value: T; label: React.ReactNode }[]
  value: T
  onChange: (v: T) => void
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex rounded-xl border border-border bg-muted/70 p-1 dark:bg-white/[0.04]", className)}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex min-h-9 flex-1 items-center whitespace-nowrap justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
      <span className="min-w-0">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold underline-offset-2 hover:underline">
          Retry
        </button>
      )}
    </div>
  )
}
