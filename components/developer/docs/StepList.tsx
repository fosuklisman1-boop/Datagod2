// components/developer/docs/StepList.tsx
import { RichText } from "./RichText"

/** Numbered steps with small circular navy badges, as in the reference "Getting your API key" list. */
export function StepList({ steps }: { steps: string[] }) {
  if (steps.length === 0) return null
  return (
    <ol className="space-y-3.5">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-3.5">
          <span
            aria-hidden
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-sm ring-4 ring-primary/10"
          >
            {i + 1}
          </span>
          <span className="sr-only">Step {i + 1}: </span>
          <p className="min-w-0 pt-0.5 text-sm leading-6 text-foreground/85">
            <RichText text={step} />
          </p>
        </li>
      ))}
    </ol>
  )
}
