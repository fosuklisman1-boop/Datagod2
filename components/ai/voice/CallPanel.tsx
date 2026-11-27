"use client"

import { useEffect, useRef } from "react"
import { Mic, MicOff, PhoneOff, Sparkles } from "lucide-react"
import { DraftCard } from "@/components/ai/DraftCard"
import type { useVoiceCall } from "./useVoiceCall"

export type VoiceCall = ReturnType<typeof useVoiceCall>

function formatLeft(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, "0")}`
}

/**
 * The live-call body of a Clings widget. Voice mode shows the Clings avatar with a speaking pulse (the persona's
 * video is never attached); video mode shows the persona video. On `lg:` it is two columns: video | captions + cards.
 */
/** `getToken` is the signed-in widgets' token getter (the one they hand their own DraftCards). Guest widgets omit it and show no Confirm card. */
export function CallPanel({ call, name, getToken }: { call: VoiceCall; name: string; getToken?: () => Promise<string> }) {
  const live = call.state === "live"
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [call.captions, call.cards])

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row" data-call-state={call.state} data-call-mode={call.mode}>
      <audio ref={call.audioRef} autoPlay />

      <div className="flex flex-shrink-0 flex-col items-center gap-3 border-b border-border bg-muted/40 p-4 lg:w-1/2 lg:justify-center lg:border-b-0 lg:border-r lg:p-6">
        {call.mode === "video" ? (
          <div className="relative aspect-video w-full max-w-md overflow-hidden rounded-2xl bg-black">
            <video ref={call.videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
            {!live && (
              <div className="absolute inset-0 flex items-center justify-center bg-primary/90 text-primary-foreground">
                <Sparkles size={32} aria-hidden="true" />
              </div>
            )}
          </div>
        ) : (
          <div className="relative flex h-24 w-24 items-center justify-center lg:h-32 lg:w-32">
            {call.speaking.avatar && <span aria-hidden="true" className="absolute inset-0 rounded-full bg-primary/30 motion-safe:animate-ping" />}
            <span
              className={`relative flex h-full w-full items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 ring-4 ${
                call.speaking.avatar ? "ring-primary/40" : "ring-transparent"
              } transition-shadow`}
            >
              <Sparkles size={36} aria-hidden="true" />
            </span>
          </div>
        )}

        <div role="status" aria-live="polite" className="text-center text-xs text-muted-foreground">
          {live ? (
            <>
              <p className="font-medium text-foreground">{name}</p>
              {call.secondsLeft !== null && <p>{formatLeft(call.secondsLeft)} left</p>}
            </>
          ) : (
            <>
              <p className="font-medium text-foreground">Connecting… this can take up to 30 seconds</p>
              {call.slow && <p className="mt-1">Still trying. A VPN or data saver can block calls.</p>}
            </>
          )}
        </div>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={call.toggleMute}
            disabled={!live}
            aria-pressed={call.muted}
            aria-label={call.muted ? "Unmute" : "Mute"}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            {call.muted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={call.hangUp}
            aria-label="Hang up"
            className="flex h-11 items-center gap-2 rounded-full bg-destructive px-5 text-sm font-semibold text-destructive-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            <PhoneOff size={16} aria-hidden="true" />
            Hang up
          </button>
        </div>
      </div>

      <div ref={logRef} role="log" aria-live="polite" aria-label="Call captions" className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 lg:w-1/2 lg:p-6">
        {call.captions.length === 0 && <p className="text-center text-xs text-muted-foreground">Captions will appear here.</p>}
        {call.captions.map((t, i) => (
          <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                t.role === "user" ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted text-foreground"
              }`}
            >
              {t.content}
            </div>
          </div>
        ))}
        {getToken && call.cards.map((c) => (
          <DraftCard
            key={c.id}
            draftId={c.id}
            initial={{ display: c.display, expires_at: c.expires_at, warnings: c.warnings }}
            getToken={getToken}
            onOutcome={(o) => call.cardOutcome(c.id, o)}
          />
        ))}
      </div>
    </div>
  )
}
