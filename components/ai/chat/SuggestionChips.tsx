"use client"

interface SuggestionChipsProps {
  chips: string[]
  onPick: (text: string) => void
  disabled?: boolean
  label?: string
}

/** Tappable suggested questions. Picking one sends it as a plain user message. */
export function SuggestionChips({ chips, onPick, disabled, label = "Suggested questions" }: SuggestionChipsProps) {
  if (chips.length === 0) return null
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <button
          key={c}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c)}
          className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
        >
          {c}
        </button>
      ))}
    </div>
  )
}
