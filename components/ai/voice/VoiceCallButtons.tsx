"use client"

import { Phone, Video } from "lucide-react"

const BASE =
  "flex h-8 w-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
const TONES = {
  /** On the navy header bar. */
  onPrimary: "bg-primary-foreground/15 text-primary-foreground hover:bg-primary-foreground/25 focus-visible:ring-primary-foreground",
  /** On a card / welcome surface. */
  surface: "border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 focus-visible:ring-primary",
} as const

/** Round phone + camera buttons. The widget renders this only when voice is available for its audience. */
export function VoiceCallButtons({
  onStart,
  disabled,
  tone = "onPrimary",
  className = "",
}: {
  onStart: (mode: "voice" | "video") => void
  disabled?: boolean
  tone?: keyof typeof TONES
  className?: string
}) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button type="button" onClick={() => onStart("voice")} disabled={disabled} aria-label="Voice call" title="Voice call" className={`${BASE} ${TONES[tone]}`}>
        <Phone size={15} aria-hidden="true" />
      </button>
      <button type="button" onClick={() => onStart("video")} disabled={disabled} aria-label="Video call" title="Video call" className={`${BASE} ${TONES[tone]}`}>
        <Video size={15} aria-hidden="true" />
      </button>
    </div>
  )
}
