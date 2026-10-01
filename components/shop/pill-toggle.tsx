"use client"

interface PillToggleProps {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  activeColor?: string
}

// Shared, defensive toggle switch. The three hand-rolled copies of this that
// existed before (my-shop, shop-pricing, shop-profile) had drifted from each
// other and relied on the thumb's `absolute` position starting from the
// button's default padding box -- on some browsers a native <button> keeps a
// few px of default padding unless explicitly zeroed, which pushed the
// translated thumb past the track's right edge (visible as a pale circular
// bump poking out past the pill). This version uses flex layout with an
// explicit p-0.5 (always overrides any default padding) instead of absolute
// positioning, and overflow-hidden on the track as a hard guarantee the thumb
// can never visually escape regardless of any future arithmetic drift.
export function PillToggle({ checked, onChange, disabled, activeColor = "bg-[#1b388b]" }: PillToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`inline-flex h-6 w-11 shrink-0 items-center overflow-hidden rounded-full p-0.5 transition-colors disabled:opacity-50 ${checked ? activeColor : "bg-muted"}`}
    >
      <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  )
}
