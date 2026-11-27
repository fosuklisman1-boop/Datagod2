"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Conversation } from "@nuancelabs/js-sdk"
import { CallTranscript, type Turn } from "@/lib/ai-voice/transcript"
import { createCallSession } from "@/lib/ai-voice/call-session"
import { createChatRelay, type RelayCard } from "@/lib/ai-voice/chat-relay"
import { clampForAppend, toVoiceText } from "@/lib/ai-voice/mask"
import { connectErrorMessage } from "@/lib/ai-voice/connect-errors"
import type { FallbackReason } from "@/lib/ai-voice/nuance"
import { getCallTurnstileToken } from "./turnstile-token"

export type CallState = "idle" | "starting" | "live" | "ended"
export type CallMode = "voice" | "video"

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

// Content / age-check ends hide the call buttons for the rest of this page session, across every widget.
let blockedForPageSession = false
const blockedListeners = new Set<() => void>()
function blockCalls() {
  blockedForPageSession = true
  blockedListeners.forEach((l) => l())
}

type Ev = { type: string } & Record<string, unknown>

export function useVoiceCall(opts: UseVoiceCallOptions) {
  const optsRef = useRef(opts)
  optsRef.current = opts

  const [state, setState] = useState<CallState>("idle")
  const [mode, setMode] = useState<CallMode>("voice")
  const [captions, setCaptions] = useState<Turn[]>([])
  const [cards, setCards] = useState<RelayCard[]>([])
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const [muted, setMuted] = useState(false)
  const [endMessage, setEndMessage] = useState<string | undefined>(undefined)
  const [speaking, setSpeaking] = useState({ user: false, avatar: false })
  const [slow, setSlow] = useState(false)
  const [blocked, setBlocked] = useState(blockedForPageSession)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const convRef = useRef<Conversation | null>(null)
  const stateRef = useRef<CallState>("idle")
  const modeRef = useRef<CallMode>("voice")
  const callIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)
  const finishedRef = useRef(true)
  const transcriptRef = useRef(new CallTranscript())
  const cardsRef = useRef<RelayCard[]>([])
  const sessionRef = useRef<ReturnType<typeof createCallSession> | null>(null)
  const unsubsRef = useRef<Array<() => void>>([])
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const setStateBoth = (s: CallState) => {
    stateRef.current = s
    setState(s)
  }

  useEffect(() => {
    const l = () => setBlocked(true)
    blockedListeners.add(l)
    return () => {
      blockedListeners.delete(l)
    }
  }, [])

  const syncMedia = useCallback(() => {
    const conv = convRef.current
    if (!conv) return
    try {
      const a = conv.avatar
      if (audioRef.current) a.audioTrack?.attach(audioRef.current)
      // Voice mode never attaches the persona's video: the Clings avatar is shown instead.
      if (modeRef.current === "video" && videoRef.current) a.videoTrack?.attach(videoRef.current)
    } catch {
      // Not connected yet.
    }
  }, [])

  /** Tears down the live handles. Returns what was held so the caller can report the end. */
  const teardown = useCallback(() => {
    finishedRef.current = true
    if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
    unsubsRef.current.forEach((u) => {
      try {
        u()
      } catch {
        // noop
      }
    })
    unsubsRef.current = []
    const conv = convRef.current
    convRef.current = null
    sessionRef.current = null
    const conversationId = conv?.id ?? undefined
    void conv?.disconnect().catch(() => {})
    const callId = callIdRef.current
    callIdRef.current = null
    return { callId, conversationId }
  }, [])

  const postEnd = useCallback(async (callId: string, reason: string, started: boolean, conversationId?: string) => {
    try {
      const auth = await optsRef.current.authHeader?.()
      await fetch("/api/ai/voice/end", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ callId, reason, started, ...(conversationId ? { conversationId } : {}) }),
      })
    } catch {
      // Best effort: the row also closes by itself.
    }
  }, [])

  /** A call that was live (or joining) is over. Idempotent. */
  const finish = useCallback(
    (reason: string, message?: string) => {
      if (finishedRef.current) return
      const { callId, conversationId } = teardown()
      if (callId) void postEnd(callId, reason, startedRef.current, conversationId)
      const turns = transcriptRef.current.captions()
      const got = cardsRef.current
      setMuted(false)
      setSpeaking({ user: false, avatar: false })
      setSecondsLeft(null)
      setSlow(false)
      setEndMessage(message)
      setStateBoth("ended")
      if (turns.length > 0 || got.length > 0) optsRef.current.onCallEnded?.(turns, got)
    },
    [teardown, postEnd],
  )

  /** A call that never got going: back to text with one calm line. */
  const failStart = useCallback(
    (message: string, reason: string) => {
      const { callId } = teardown()
      if (callId) void postEnd(callId, reason, false)
      setSlow(false)
      setSecondsLeft(null)
      setEndMessage(message)
      setStateBoth("idle")
    },
    [teardown, postEnd],
  )

  const start = useCallback(
    async (nextMode: CallMode) => {
      if (blockedForPageSession) return
      if (stateRef.current === "starting" || stateRef.current === "live") return
      setStateBoth("starting")
      setMode(nextMode)
      modeRef.current = nextMode
      setEndMessage(undefined)
      setCaptions([])
      setCards([])
      setMuted(false)
      setSlow(false)
      setSecondsLeft(null)
      transcriptRef.current = new CallTranscript()
      cardsRef.current = []
      startedRef.current = false
      finishedRef.current = false

      try {
        const o = optsRef.current
        const auth = await o.authHeader?.()
        const isVisitor = o.context === "home" || o.context === "storefront"
        const turnstileToken = isVisitor ? await getCallTurnstileToken() : undefined

        const res = await fetch("/api/ai/voice/token", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
          body: JSON.stringify({
            context: o.context,
            mode: nextMode,
            ...(o.shopSlug ? { shopSlug: o.shopSlug } : {}),
            ...(turnstileToken ? { turnstileToken } : {}),
          }),
        })
        const body = (await res.json().catch(() => null)) as {
          token?: string
          callId?: string
          maxSeconds?: number
          fallback?: string
          reason?: FallbackReason
        } | null
        if (finishedRef.current) {
          // Hung up while the token was on its way: give the slot back.
          if (body?.callId) void postEnd(body.callId, "user", false)
          return
        }
        if (!res.ok || !body) return failStart(connectErrorMessage(null), "token_failed")
        if (body.fallback === "text" || !body.token || !body.callId) return failStart(connectErrorMessage(null, body.reason), "fallback")
        const token = body.token
        callIdRef.current = body.callId

        const sdk = await import("@nuancelabs/js-sdk")
        const conv = sdk.createNuanceConversation({
          token: async () => token,
          maxSessionSeconds: body.maxSeconds,
          mediaDevices: { cameraEnabled: nextMode === "video" },
        })
        convRef.current = conv

        const relay = createChatRelay({
          context: o.context,
          shopSlug: o.shopSlug,
          authHeader: async () => optsRef.current.authHeader?.(),
          conversationKey: () => optsRef.current.conversationKey?.() ?? null,
          onCards: (found) => {
            const known = new Set(cardsRef.current.map((c) => c.id))
            const fresh = found.filter((c) => !known.has(c.id))
            if (fresh.length === 0) return
            cardsRef.current = [...cardsRef.current, ...fresh]
            setCards(cardsRef.current)
          },
        })
        sessionRef.current = createCallSession({
          link: {
            send: (ev) => conv.sendInterfaceEvent(ev),
            connected: () => stateRef.current === "live" && !finishedRef.current,
          },
          relay,
          transcript: transcriptRef.current,
        })

        // Subscribe before connect() so the first events are seen.
        unsubsRef.current.push(
          conv.onInterfaceEvent((raw) => {
            const ev = raw as Ev
            if (typeof ev.type !== "string") return
            transcriptRef.current.onEvent(ev)
            setCaptions(transcriptRef.current.captions())
            if (ev.type === "session.closed") {
              const reason = typeof ev.reason === "string" ? ev.reason : "closed"
              const message = typeof ev.message === "string" ? ev.message : undefined
              if (reason === "content" || reason === "age_check") {
                blockCalls()
                finish(reason, message)
              } else finish(reason)
              return
            }
            void sessionRef.current?.onInterfaceEvent(ev)
          }),
          conv.onChange((ev) => {
            switch (ev.type) {
              case "avatar-presented": {
                if (finishedRef.current) break
                startedRef.current = true
                setStateBoth("live")
                syncMedia()
                // The persona never speaks first: ask it to open. Plain ASCII, masked, same as every other line sent.
                const greeting = clampForAppend(toVoiceText(`Greet the user as ${optsRef.current.assistantName} and ask how you can help.`))
                void conv.sendInterfaceEvent({ type: "response.create", response: { instructions: greeting } }).catch(() => {})
                break
              }
              case "tracks-changed":
              case "avatar-ready":
                syncMedia()
                break
              case "speaking-changed":
                setSpeaking((s) => ({ ...s, [ev.participant]: ev.isSpeaking }))
                break
              case "join-slow":
                setSlow(true)
                break
              case "time-remaining":
                setSecondsLeft(ev.secondsRemaining)
                break
              case "session-ended":
                if (ev.reason === "policy-violation" || ev.reason === "age-check") {
                  blockCalls()
                  finish(ev.reason === "age-check" ? "age_check" : "content", ev.message)
                } else finish(ev.reason)
                break
            }
          }),
        )

        // Count down locally between the SDK's corrections.
        tickRef.current = setInterval(() => setSecondsLeft((s) => (s === null ? s : Math.max(0, s - 1))), 1000)

        try {
          await conv.connect()
        } catch (err) {
          // A server end during the join already finished the call; only report a start that is still pending.
          if (!finishedRef.current) failStart(connectErrorMessage(err), "connect_failed")
          return
        }
        // connect() resolves with the call already over when the server ended it while joining.
        if (!finishedRef.current && conv.state === "disconnected") finish("ended")
      } catch (err) {
        if (!finishedRef.current) failStart(connectErrorMessage(err), "start_failed")
      }
    },
    [finish, failStart, postEnd, syncMedia],
  )

  const hangUp = useCallback(() => {
    finish("user")
  }, [finish])

  const toggleMute = useCallback(() => {
    const conv = convRef.current
    if (!conv || stateRef.current !== "live") return
    const next = !muted
    setMuted(next)
    void conv.sendInterfaceEvent({ type: next ? "session.input_audio.mute" : "session.input_audio.unmute" }).catch(() => setMuted(!next))
  }, [muted])

  /** A card shown during the call reached a final state: tell the persona (masked, one line). */
  const cardOutcome = useCallback((cardId: string, outcome: "confirmed" | "cancelled" | "failed") => {
    const card = cardsRef.current.find((c) => c.id === cardId)
    if (!card || !sessionRef.current) return
    void sessionRef.current.onCardOutcome({ summary: card.summary, outcome })
  }, [])

  // Attach media once the panel's elements exist.
  useEffect(() => {
    if (state === "live" || state === "starting") syncMedia()
  }, [state, syncMedia])

  // Leaving the page ends the call (no state updates: the component is going away).
  useEffect(
    () => () => {
      if (finishedRef.current) return
      const { callId, conversationId } = teardown()
      if (callId) void postEnd(callId, "page_left", startedRef.current, conversationId)
    },
    [teardown, postEnd],
  )

  return {
    state,
    mode,
    captions,
    cards,
    secondsLeft,
    muted,
    endMessage,
    speaking,
    slow,
    blocked,
    videoRef,
    audioRef,
    start,
    hangUp,
    toggleMute,
    cardOutcome,
  }
}
