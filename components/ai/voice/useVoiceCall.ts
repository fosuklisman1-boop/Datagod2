"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { Turn } from "@/lib/ai-voice/transcript"
import type { RelayCard } from "@/lib/ai-voice/chat-relay"
import {
  callsBlocked,
  createCallController,
  subscribeBlocked,
  type CallMode,
  type CallState,
} from "@/lib/ai-voice/call-controller"
import { getCallTurnstileToken } from "./turnstile-token"

export type { CallState, CallMode }

export interface UseVoiceCallOptions {
  context: "home" | "storefront" | "dashboard" | "admin"
  shopSlug?: string
  /** Full header value, e.g. `Bearer <jwt>`. Omit for visitors. */
  authHeader?: () => Promise<string | undefined>
  assistantName: string
  conversationKey?: () => string | null
  /** Fired once when a call that produced captions or cards ends, so the widget can keep them in its chat history. */
  onCallEnded?: (turns: Turn[], cards: RelayCard[]) => void
}

/** Thin React wrapper over the plain call controller (lib/ai-voice/call-controller.ts). */
export function useVoiceCall(opts: UseVoiceCallOptions) {
  const optsRef = useRef(opts)
  optsRef.current = opts

  const [controller] = useState(() =>
    createCallController({
      get context() {
        return optsRef.current.context
      },
      get shopSlug() {
        return optsRef.current.shopSlug
      },
      authHeader: async () => optsRef.current.authHeader?.(),
      assistantName: () => optsRef.current.assistantName,
      conversationKey: () => optsRef.current.conversationKey?.() ?? null,
      onCallEnded: (t, c) => optsRef.current.onCallEnded?.(t, c),
      loadSdk: () => import("@nuancelabs/js-sdk"),
      getTurnstileToken: () => getCallTurnstileToken(),
    }),
  )

  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const blocked = useSyncExternalStore(subscribeBlocked, callsBlocked, () => false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Attach media once the panel's elements exist.
  useEffect(() => {
    if (snap.state === "live" || snap.state === "starting") controller.setElements(videoRef.current, audioRef.current)
  }, [snap.state, controller])

  // Leaving the page ends the call.
  useEffect(() => () => controller.dispose(), [controller])

  const start = useCallback((m: CallMode) => controller.start(m), [controller])
  const hangUp = useCallback(() => controller.hangUp(), [controller])
  /** Reads the live controller (not a render snapshot), so close handlers never see a stale answer. */
  const isActive = useCallback(() => {
    const s = controller.getSnapshot().state
    return s === "starting" || s === "live"
  }, [controller])
  const toggleMute =useCallback(() => void controller.toggleMute(), [controller])
  const cardOutcome = useCallback(
    (id: string, o: "confirmed" | "cancelled" | "failed") => controller.cardOutcome(id, o),
    [controller],
  )

  return { ...snap, blocked, videoRef, audioRef, start, hangUp, isActive, toggleMute, cardOutcome }
}
