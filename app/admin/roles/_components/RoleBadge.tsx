import { Award, Briefcase, Crown, Gem, Rocket, Shield, Star, Zap, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const ICONS: Record<string, LucideIcon> = { Crown, Star, Gem, Rocket, Shield, Zap, Award, Briefcase }

/** Tailwind classes per badge colour. Navy is the brand accent (--primary). */
export const BADGE_CLASSES: Record<string, string> = {
  navy: "bg-primary/10 text-primary border-primary/30",
  purple: "bg-purple-100 text-purple-800 border-purple-300",
  emerald: "bg-emerald-100 text-emerald-800 border-emerald-300",
  amber: "bg-amber-100 text-amber-800 border-amber-300",
  rose: "bg-rose-100 text-rose-800 border-rose-300",
  slate: "bg-slate-100 text-slate-800 border-slate-300",
}

/** Small coloured role pill. Shared with the Task 11 tabs. */
export function RoleBadge({ name, color, icon }: { name: string; color: string | null; icon: string | null }) {
  const Icon = icon ? ICONS[icon] : undefined
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        BADGE_CLASSES[color ?? "navy"] ?? BADGE_CLASSES.navy,
      )}
    >
      {Icon ? <Icon className="h-3 w-3" aria-hidden /> : null}
      {name}
    </span>
  )
}
