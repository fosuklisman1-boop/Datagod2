import { cn } from "@/lib/utils"

/**
 * Sidebar "NEW" marker (see lib/nav-new.ts). Full pill next to the label when
 * the sidebar is expanded; a small dot on the icon when it is collapsed.
 * Navy brand accent via bg-primary; the inset ring keeps it defined on the
 * dark admin skin.
 */
export function NewTag({ compact = false, className }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <>
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background",
            className
          )}
        />
        <span className="sr-only">New</span>
      </>
    )
  }
  return (
    <span
      aria-label="New"
      title="New"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none tracking-wide text-primary-foreground ring-1 ring-inset ring-primary-foreground/25",
        className
      )}
    >
      NEW
    </span>
  )
}
