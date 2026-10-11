import { AlertCircle, Check } from "lucide-react"
import type { StepState } from "../../_lib/view"

export function Stepper({ steps }: { steps: { label: string; state: StepState }[] }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Business verification progress">
      {steps.map((s, i) => (
        <li key={s.label} className="flex flex-col items-center gap-1.5 text-center" aria-current={s.state === "current" ? "step" : undefined}>
          <span
            className={
              "grid h-8 w-8 place-items-center rounded-full border text-xs font-semibold " +
              (s.state === "done" ? "border-primary bg-primary text-primary-foreground"
                : s.state === "current" ? "border-primary bg-primary/10 text-primary"
                : s.state === "error" ? "border-destructive bg-destructive/10 text-destructive"
                : "border-border bg-muted text-muted-foreground")
            }
          >
            {s.state === "done" ? <Check className="h-4 w-4" aria-hidden /> : s.state === "error" ? <AlertCircle className="h-4 w-4" aria-hidden /> : i + 1}
          </span>
          <span className={"text-[11px] leading-tight sm:text-xs " + (s.state === "todo" ? "text-muted-foreground" : "font-medium text-foreground")}>
            {s.label}
            <span className="sr-only">{s.state === "done" ? " (complete)" : s.state === "current" ? " (current step)" : s.state === "error" ? " (needs attention)" : ""}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
