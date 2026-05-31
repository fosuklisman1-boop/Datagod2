"use client"

// Honeypot field: hidden from real users via CSS + ARIA + tabIndex, but bots
// that auto-fill forms by field name will populate it. Any non-empty value
// reaching the server = bot → reject. Zero UX cost when implemented correctly.
//
// Critical accessibility: aria-hidden + position off-screen ensures screen
// readers don't announce it, and tabIndex={-1} keeps it out of keyboard nav.

interface HoneypotFieldProps {
  value: string
  onChange: (v: string) => void
}

export default function HoneypotField({ value, onChange }: HoneypotFieldProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        left: "-9999px",
        top: "-9999px",
        width: "1px",
        height: "1px",
        opacity: 0,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <label htmlFor="hp-website">Website</label>
      <input
        id="hp-website"
        type="text"
        name="website"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
      />
    </div>
  )
}
