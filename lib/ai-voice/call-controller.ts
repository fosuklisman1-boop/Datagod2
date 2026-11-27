// React-free call lifecycle: start / finish / hang up / mute. The hook is a thin wrapper around this.
// Every start gets a generation number; any step that resumes after an await for an older generation
// disconnects what it created and ends its call row instead of touching the current call.
import type { Conversation } from "@nuancelabs/js-sdk"
import { CallTranscript, type Turn } from "./transcript"
import { createCallSession } from "./call-session"
import { createChatRelay, type RelayCard } from "./chat-relay"
import { clampForAppend, toVoiceText } from "./mask"
import { connectErrorMessage } from "./connect-errors"
import { toClientEndReason } from "./end-reasons"
import type { FallbackReason } from "./nuance"

export type CallState = "idle" | "queued" | "starting" | "live" | "ended"
export type CallMode = "voice" | "video"

/** How often a waiting caller checks in with the line. */
export const QUEUE_POLL_MS = 5000

export interface CallSnapshot {
  state: CallState
  mode: CallMode
  /** Only while state is "queued": place in the line (1 = next) and the rough wait. */
  queue?: { position: number; etaSeconds: number }
  captions: Turn[]
  cards: RelayCard[]
  secondsLeft: number | null
  muted: boolean
  endMessage?: string
  speaking: { user: boolean; avatar: boolean }
  slow: boolean
}

export interface SdkLike {
  createNuanceConversation(o: {
    token: () => Promise<string>
    maxSessionSeconds?: number
    mediaDevices: { cameraEnabled: boolean }
  }): Conversation
}

export interface CallControllerDeps {
  context: "home" | "storefront" | "dashboard" | "admin"
  shopSlug?: string
  authHeader?: () => Promise<string | undefined>
  assistantName: () => string
  conversationKey?: () => string | null
  onCallEnded?: (turns: Turn[], cards: RelayCard[]) => void
  /** The storefront order form data from a hand-off (what the text widget gets from checkout_prefill). */
  onCheckoutPrefill?: (data: unknown) => void
  /** Quick-action buttons from a hand-off (what the text widget gets from action_buttons). */
  onActionButtons?: (buttons: unknown[]) => void
  fetchImpl?: typeof fetch
  loadSdk: () => Promise<SdkLike>
  getTurnstileToken?: () => Promise<string | undefined>
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (h: unknown) => void
}

// Content / age-check ends hide the call buttons for the rest of this page session, across every widget.
let blockedForPageSession = false
const blockedListeners = new Set<() => void>()
export const callsBlocked = () => blockedForPageSession
export function subscribeBlocked(l: () => void): () => void {
  blockedListeners.add(l)
  return () => {
    blockedListeners.delete(l)
  }
}
function blockCalls() {
  blockedForPageSession = true
  blockedListeners.forEach((l) => l())
}
/** Test helper. */
export function resetBlockedForTests() {
  blockedForPageSession = false
}

const LINE_EXPIRED = "Your place in line expired. Tap to try again."
const positive = (v: unknown, floor: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(floor, Math.round(v)) : floor)

type Ev = { type: string } & Record<string, unknown>

const INITIAL: CallSnapshot = {
  state: "idle",
  mode: "voice",
  queue: undefined,
  captions: [],
  cards: [],
  secondsLeft: null,
  muted: false,
  speaking: { user: false, avatar: false },
  slow: false,
}

export function createCallController(deps: CallControllerDeps) {
  const doFetch = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const setIv = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearIv = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))

  let snap: CallSnapshot = { ...INITIAL }
  const listeners = new Set<() => void>()
  const patch = (p: Partial<CallSnapshot>) => {
    snap = { ...snap, ...p }
    listeners.forEach((l) => l())
  }

  let gen = 0
  let conv: Conversation | null = null
  let callId: string | null = null
  let started = false
  let startedAt: string | null = null
  // Last auth header seen at start: a page-hide hang-up has no time to await a fresh one.
  let cachedAuth: string | undefined
  let hiding = false
  let finished = true
  let transcript = new CallTranscript()
  let cards: RelayCard[] = []
  let session: ReturnType<typeof createCallSession> | null = null
  let unsubs: Array<() => void> = []
  let tick: unknown = null
  let video: HTMLVideoElement | null = null
  let audio: HTMLAudioElement | null = null
  const ended = new Set<string>()
  // Waiting line: the ticket held while state is "queued", its poll timer, and the tickets already left (leave posts once).
  let ticketId: string | null = null
  let queueTimer: unknown = null
  let polling = false
  const leftTickets = new Set<string>()

  async function postLeave(id: string) {
    if (leftTickets.has(id)) return
    leftTickets.add(id)
    try {
      // Same as postEnd: while the page is hiding no await comes before the request, so it goes out synchronously.
      const auth = hiding ? cachedAuth : await deps.authHeader?.()
      await doFetch("/api/ai/voice/queue", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ ticketId: id, action: "leave" }),
      })
    } catch {
      // Best effort. A ticket nobody checks in on expires on the server after about 20 s.
    }
  }

  /** Stops polling and forgets the ticket; returns it so the caller can post the leave. */
  function dropQueue(): string | null {
    if (queueTimer !== null) {
      clearIv(queueTimer)
      queueTimer = null
    }
    const id = ticketId
    ticketId = null
    polling = false
    return id
  }

  async function postEnd(id: string, reason: string, wasStarted: boolean, conversationId?: string, presentedAt?: string | null) {
    if (ended.has(id)) return
    ended.add(id)
    try {
      // While the page is hiding the cached header is used: no await before the request, so it goes out
      // synchronously. Otherwise ask for a fresh one (a long call can outlive the session token).
      const auth = hiding ? cachedAuth : await deps.authHeader?.()
      await doFetch("/api/ai/voice/end", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({
          callId: id,
          reason: toClientEndReason(reason),
          started: wasStarted,
          ...(wasStarted && presentedAt ? { startedAt: presentedAt } : {}),
          ...(conversationId ? { conversationId } : {}),
        }),
      })
    } catch {
      // Best effort. A row that never gets its end stays open and blocks this identity's next call until
      // max_seconds + 60 s have passed (the token route's concurrency check), so a lost end is not permanent.
    }
  }

  function syncMedia() {
    if (!conv) return
    try {
      const a = conv.avatar
      if (audio) a.audioTrack?.attach(audio)
      // Voice mode never attaches the persona's video: the Clings avatar is shown instead.
      if (snap.mode === "video" && video) a.videoTrack?.attach(video)
    } catch {
      // Not connected yet.
    }
  }

  /** Drops the live handles of the current call. */
  function teardown() {
    finished = true
    if (tick !== null) {
      clearIv(tick)
      tick = null
    }
    unsubs.forEach((u) => {
      try {
        u()
      } catch {
        // noop
      }
    })
    unsubs = []
    const c = conv
    const id = callId
    conv = null
    callId = null
    session = null
    const conversationId = c?.id ?? undefined
    void c?.disconnect().catch(() => {})
    return { id, conversationId }
  }

  function finish(reason: string, message?: string) {
    if (finished) return
    gen++ // any start still waiting is now stale
    const { id, conversationId } = teardown()
    if (id) void postEnd(id, reason, started, conversationId, startedAt)
    const turns = transcript.captions()
    const got = cards
    patch({ muted: false, speaking: { user: false, avatar: false }, secondsLeft: null, slow: false, endMessage: message, state: "ended" })
    if (turns.length > 0 || got.length > 0) deps.onCallEnded?.(turns, got)
  }

  function failStart(message: string, reason: string) {
    const { id } = teardown()
    if (id) void postEnd(id, reason, false)
    patch({ slow: false, secondsLeft: null, endMessage: message, state: "idle", queue: undefined })
  }

  /** The line is where this caller waits: no conversation, no call row, just a ticket checked in on every few seconds. */
  function enterQueue(my: number, mode: CallMode, id: string, position?: number, eta?: number) {
    dropQueue() // a caller put back in line after an admission lapsed replaces the old poll
    ticketId = id
    patch({ state: "queued", mode, endMessage: undefined, queue: { position: positive(position, 1), etaSeconds: positive(eta, 0) } })
    queueTimer = setIv(() => { void pollQueue(my) }, QUEUE_POLL_MS)
  }

  /** The wait is over without a call (expired, left elsewhere, or the server no longer knows the ticket). */
  function endWait(message: string) {
    dropQueue()
    finished = true
    patch({ state: "idle", queue: undefined, endMessage: message })
  }

  async function pollQueue(my: number) {
    const id = ticketId
    if (my !== gen || !id || polling) return
    polling = true
    const live = () => my === gen && ticketId === id
    try {
      const auth = await deps.authHeader?.()
      if (!live()) return
      cachedAuth = auth
      const res = await doFetch("/api/ai/voice/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ ticketId: id }),
      })
      if (!live()) return
      if (res.status === 404) return endWait(LINE_EXPIRED)
      if (!res.ok) return // a hiccup: the next check-in tries again; the server drops the ticket if they all fail
      const body = (await res.json().catch(() => null)) as { status?: string; position?: number; etaSeconds?: number } | null
      if (!live() || !body) return
      if (body.status === "waiting") {
        patch({ queue: { position: positive(body.position, 1), etaSeconds: positive(body.etaSeconds, 0) } })
      } else if (body.status === "admitted") {
        // Their turn: stop polling and start the call the normal way, presenting the ticket.
        const mode = snap.mode
        dropQueue()
        patch({ state: "starting", queue: undefined })
        await proceed(my, mode, id)
      } else if (body.status === "expired" || body.status === "left" || body.status === "used") {
        endWait(LINE_EXPIRED)
      }
    } catch {
      // Network blip: try again on the next check-in.
    } finally {
      polling = false
    }
  }

  /** Hang up / close / page hide while waiting: give the place back and return to idle. */
  function leaveQueue() {
    gen++ // a poll or token answer still in flight is now stale
    const id = dropQueue()
    finished = true
    patch({ state: "idle", queue: undefined })
    if (id) void postLeave(id)
  }

  async function start(mode: CallMode): Promise<void> {
    if (blockedForPageSession) return
    if (snap.state === "starting" || snap.state === "live" || snap.state === "queued") return
    const my = ++gen
    transcript = new CallTranscript()
    cards = []
    started = false
    startedAt = null
    finished = false
    patch({ ...INITIAL, state: "starting", mode, endMessage: undefined })
    return proceed(my, mode, undefined)
  }

  /**
   * Asks the token route for a call. First time: no ticket. After the line admitted this caller: the same generation
   * asks again with the ticket and carries on as a normal start. A queued answer parks the caller in the line instead.
   */
  async function proceed(my: number, mode: CallMode, admittedTicket: string | undefined): Promise<void> {
    const stale = () => my !== gen

    // What THIS start created; a stale start cleans these up and never touches the current call.
    let myCallId: string | null = null
    let myConv: Conversation | null = null
    const dropStale = () => {
      if (myConv && myConv !== conv) void myConv.disconnect().catch(() => {})
      if (myCallId) void postEnd(myCallId, "user", false)
    }

    try {
      const auth = await deps.authHeader?.()
      cachedAuth = auth
      const isVisitor = deps.context === "home" || deps.context === "storefront"
      const turnstileToken = isVisitor ? await deps.getTurnstileToken?.() : undefined
      if (stale()) return

      const res = await doFetch("/api/ai/voice/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({
          context: deps.context,
          mode,
          ...(deps.shopSlug ? { shopSlug: deps.shopSlug } : {}),
          ...(turnstileToken ? { turnstileToken } : {}),
          ...(admittedTicket ? { ticketId: admittedTicket } : {}),
        }),
      })
      const body = (await res.json().catch(() => null)) as {
        token?: string
        callId?: string
        maxSeconds?: number
        fallback?: string
        reason?: FallbackReason
        queued?: boolean
        ticketId?: string
        position?: number
        etaSeconds?: number
      } | null
      myCallId = body?.callId ?? null
      if (stale()) {
        // A ticket handed out to a start that is already gone must not sit in the line.
        if (body?.queued && typeof body.ticketId === "string") void postLeave(body.ticketId)
        return dropStale()
      }
      if (!res.ok || !body) return failStart(connectErrorMessage(null), "token_failed")
      if (body.queued && typeof body.ticketId === "string") return enterQueue(my, mode, body.ticketId, body.position, body.etaSeconds)
      if (body.fallback === "text" || !body.token || !body.callId) return failStart(connectErrorMessage(null, body.reason), "fallback")
      const token = body.token
      callId = body.callId

      const sdk = await deps.loadSdk()
      if (stale()) return dropStale()
      const c = sdk.createNuanceConversation({
        token: async () => token,
        maxSessionSeconds: body.maxSeconds,
        mediaDevices: { cameraEnabled: mode === "video" },
      })
      myConv = c
      conv = c

      const relay = createChatRelay({
        context: deps.context,
        shopSlug: deps.shopSlug,
        authHeader: async () => deps.authHeader?.(),
        conversationKey: () => deps.conversationKey?.() ?? null,
        fetchImpl: doFetch,
        onCheckoutPrefill: (data) => {
          if (!stale() && !finished) deps.onCheckoutPrefill?.(data)
        },
        onActionButtons: (buttons) => {
          if (!stale() && !finished) deps.onActionButtons?.(buttons)
        },
        onCards: (found) => {
          if (stale()) return
          const known = new Set(cards.map((x) => x.id))
          const fresh = found.filter((x) => !known.has(x.id))
          if (fresh.length === 0) return
          cards = [...cards, ...fresh]
          patch({ cards })
        },
      })
      session = createCallSession({
        link: { send: (ev) => c.sendInterfaceEvent(ev), connected: () => snap.state === "live" && !finished && !stale() },
        relay,
        transcript,
      })

      // Subscribe before connect() so the first events are seen.
      unsubs.push(
        c.onInterfaceEvent((raw) => {
          if (stale()) return
          const ev = raw as Ev
          if (typeof ev.type !== "string") return
          transcript.onEvent(ev)
          patch({ captions: transcript.captions() })
          if (ev.type === "session.closed") {
            const reason = typeof ev.reason === "string" ? ev.reason : "closed"
            const message = typeof ev.message === "string" ? ev.message : undefined
            if (reason === "content" || reason === "age_check") {
              blockCalls()
              finish(reason, message)
            } else finish(reason)
            return
          }
          void session?.onInterfaceEvent(ev)
        }),
        c.onChange((ev) => {
          if (stale()) return
          switch (ev.type) {
            case "avatar-presented": {
              if (finished) break
              started = true
              startedAt = new Date().toISOString()
              patch({ state: "live" })
              syncMedia()
              // The persona never speaks first. Plain ASCII, masked, like every other line sent to Nuance.
              const greeting = clampForAppend(toVoiceText(`Greet the user as ${deps.assistantName()} and ask how you can help.`))
              void c.sendInterfaceEvent({ type: "response.create", response: { instructions: greeting } }).catch(() => {})
              break
            }
            case "tracks-changed":
            case "avatar-ready":
              syncMedia()
              break
            case "speaking-changed":
              patch({ speaking: { ...snap.speaking, [ev.participant]: ev.isSpeaking } })
              break
            case "join-slow":
              patch({ slow: true })
              break
            case "time-remaining":
              patch({ secondsLeft: ev.secondsRemaining })
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
      tick = setIv(() => {
        if (snap.secondsLeft !== null) patch({ secondsLeft: Math.max(0, snap.secondsLeft - 1) })
      }, 1000)

      try {
        await c.connect()
      } catch (err) {
        if (stale()) return dropStale()
        return failStart(connectErrorMessage(err), "connect_failed")
      }
      if (stale()) return dropStale()
      // connect() resolves with the call already over when the server ended it while joining.
      if (!finished && c.state === "disconnected") finish("ended")
    } catch (err) {
      if (stale()) return dropStale()
      failStart(connectErrorMessage(err), "start_failed")
    }
  }

  function hangUp() {
    if (snap.state === "queued") return leaveQueue()
    if (snap.state === "starting" || snap.state === "live") finish("user")
  }

  async function toggleMute() {
    const c = conv
    if (!c || snap.state !== "live") return
    const mine = gen
    try {
      if (c.user.isMuted) await c.user.unmuteAudio()
      else await c.user.muteAudio()
    } catch {
      // fall through: show what the SDK says
    }
    // The label follows the SDK, never a guess.
    if (mine !== gen || conv !== c) return
    try {
      patch({ muted: c.user.isMuted })
    } catch {
      // call ended meanwhile
    }
  }

  function cardOutcome(cardId: string, outcome: "confirmed" | "cancelled" | "failed") {
    const card = cards.find((x) => x.id === cardId)
    if (!card || !session) return
    void session.onCardOutcome({ summary: card.summary, outcome })
  }

  return {
    getSnapshot: () => snap,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    start,
    hangUp,
    toggleMute,
    cardOutcome,
    setElements(v: HTMLVideoElement | null, a: HTMLAudioElement | null) {
      video = v
      audio = a
      syncMedia()
    },
    /** Component unmounted: end the call without publishing state. */
    dispose() {
      if (snap.state === "queued") {
        hiding = true // unmount: same synchronous send as a page hide
        gen++
        const id = dropQueue()
        finished = true
        try {
          if (id) void postLeave(id)
        } finally {
          hiding = false
        }
        return
      }
      if (finished) return
      gen++
      const { id, conversationId } = teardown()
      hiding = true // unmount: same synchronous send as a page hide
      try {
        if (id) void postEnd(id, "page_left", started, conversationId, startedAt)
      } finally {
        hiding = false
      }
    },
    /** The page is being hidden or closed: hang up now (the request goes out synchronously, keepalive). */
    pageHide() {
      if (snap.state === "queued") {
        hiding = true
        try {
          leaveQueue()
        } finally {
          hiding = false
        }
        return
      }
      if (snap.state !== "starting" && snap.state !== "live") return
      hiding = true
      try {
        finish("page_left")
      } finally {
        hiding = false
      }
    },
  }
}
