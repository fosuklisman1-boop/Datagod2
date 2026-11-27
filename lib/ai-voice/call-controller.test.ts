import { beforeEach, describe, expect, it, vi } from "vitest"
import { createCallController, resetBlockedForTests, type SdkLike } from "./call-controller"

type Handler = (ev: any) => void

function fakeConv(id: string) {
  const changeHandlers: Handler[] = []
  const ifaceHandlers: Handler[] = []
  let resolveConnect!: () => void
  const connectP = new Promise<void>((r) => (resolveConnect = r))
  const conv: any = {
    id,
    state: "connecting",
    connected: false,
    disconnected: 0,
    user: {
      isMuted: false,
      muteAudio: vi.fn(async () => { conv.user.isMuted = true }),
      unmuteAudio: vi.fn(async () => { conv.user.isMuted = false }),
    },
    avatar: { audioTrack: null, videoTrack: null },
    onChange: (h: Handler) => (changeHandlers.push(h), () => {}),
    onInterfaceEvent: (h: Handler) => (ifaceHandlers.push(h), () => {}),
    emitIface: (ev: unknown) => ifaceHandlers.forEach((h) => h(ev)),
    sendInterfaceEvent: vi.fn(async () => {}),
    connect: vi.fn(async () => { conv.connected = true; await connectP }),
    disconnect: vi.fn(async () => { conv.disconnected++ }),
    emit: (ev: unknown) => changeHandlers.forEach((h) => h(ev)),
    resolveConnect,
  }
  return conv
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function setup(extra: Partial<Parameters<typeof createCallController>[0]> = {}, chatSse = "") {
  const convs: any[] = []
  const endCalls: any[] = []
  const tokenGates: Array<ReturnType<typeof deferred<void>>> = []
  let n = 0
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    if (url === "/api/ai/voice/token") {
      const my = ++n
      const gate = tokenGates[my - 1]
      if (gate) await gate.promise
      return new Response(JSON.stringify({ token: `t${my}`, callId: `call-${my}`, maxSeconds: 300 }), { status: 200 })
    }
    if (url === "/api/ai/voice/end") {
      endCalls.push(JSON.parse(init.body))
      return new Response(null, { status: 204 })
    }
    if (url === "/api/ai/chat") return new Response(chatSse, { status: 200 })
    throw new Error("unexpected " + url)
  })
  const sdk: SdkLike = {
    createNuanceConversation: vi.fn(() => {
      const c = fakeConv(`conv-${convs.length + 1}`)
      convs.push(c)
      return c
    }) as any,
  }
  const ctrl = createCallController({
    context: "dashboard",
    assistantName: () => "Clings",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    loadSdk: async () => sdk,
    setInterval: () => 1,
    clearInterval: () => {},
    ...extra,
  })
  return { ctrl, convs, endCalls, tokenGates, sdk, fetchImpl }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => resetBlockedForTests())

describe("call controller", () => {
  it("(a) hang up during the token wait then re-start creates only one conversation", async () => {
    const { ctrl, convs, endCalls, tokenGates, sdk } = setup()
    const gate = deferred<void>()
    tokenGates.push(gate) // first token request is held
    const first = ctrl.start("voice")
    await flush()
    ctrl.hangUp()
    expect(ctrl.getSnapshot().state).toBe("ended")
    const second = ctrl.start("voice") // second token is immediate
    await flush()
    expect(convs).toHaveLength(1)
    // the old token finally arrives: it must not create a conversation, and its slot is given back
    gate.resolve()
    await first
    await flush()
    expect(sdk.createNuanceConversation).toHaveBeenCalledTimes(1)
    expect(endCalls.filter((e) => e.callId === "call-1")).toHaveLength(1)
    // the live (second) call is untouched
    expect(convs[0].disconnected).toBe(0)
    convs[0].emit({ type: "avatar-presented" })
    expect(ctrl.getSnapshot().state).toBe("live")
    convs[0].resolveConnect()
    await second
  })

  it("(b) toggleMute uses user.muteAudio/unmuteAudio and muted follows isMuted", async () => {
    const { ctrl, convs } = setup()
    const p = ctrl.start("voice")
    await flush()
    convs[0].emit({ type: "avatar-presented" })
    await ctrl.toggleMute()
    expect(convs[0].user.muteAudio).toHaveBeenCalledOnce()
    expect(ctrl.getSnapshot().muted).toBe(true)
    await ctrl.toggleMute()
    expect(convs[0].user.unmuteAudio).toHaveBeenCalledOnce()
    expect(ctrl.getSnapshot().muted).toBe(false)
    // an SDK that refuses to mute must not make the label lie
    convs[0].user.muteAudio = vi.fn(async () => { throw new Error("nope") })
    await ctrl.toggleMute()
    expect(ctrl.getSnapshot().muted).toBe(false)
    convs[0].resolveConnect()
    await p
  })

  it("(c) hang up while live disconnects and posts /voice/end once", async () => {
    const { ctrl, convs, endCalls } = setup()
    const p = ctrl.start("voice")
    await flush()
    convs[0].emit({ type: "avatar-presented" })
    ctrl.hangUp()
    ctrl.hangUp()
    await flush()
    expect(convs[0].disconnected).toBeGreaterThanOrEqual(1)
    expect(endCalls).toHaveLength(1)
    expect(endCalls[0]).toMatchObject({ callId: "call-1", reason: "user", started: true })
    expect(ctrl.getSnapshot().state).toBe("ended")
    convs[0].resolveConnect()
    await p
    expect(endCalls).toHaveLength(1)
  })

  it("end reasons are always ones /voice/end accepts (an unknown SDK reason becomes 'ended')", async () => {
    const { ctrl, convs, endCalls } = setup()
    const p = ctrl.start("voice")
    await flush()
    convs[0].emit({ type: "avatar-presented" })
    convs[0].emit({ type: "session-ended", reason: "some-new-sdk-reason" })
    await flush()
    expect(endCalls[0].reason).toBe("ended")
    convs[0].resolveConnect()
    await p
  })

  it("M1: the end post carries the time the persona was presented, and no startedAt when it never was", async () => {
    const { ctrl, convs, endCalls } = setup()
    const p = ctrl.start("voice")
    await flush()
    convs[0].emit({ type: "avatar-presented" })
    ctrl.hangUp()
    await flush()
    expect(endCalls[0].started).toBe(true)
    expect(Number.isFinite(Date.parse(endCalls[0].startedAt))).toBe(true)
    convs[0].resolveConnect()
    await p
    const second = setup()
    const p2 = second.ctrl.start("voice")
    await flush()
    second.ctrl.hangUp()
    await flush()
    expect(second.endCalls[0].started).toBe(false)
    expect(second.endCalls[0].startedAt).toBeUndefined()
    second.convs[0].resolveConnect()
    await p2
  })

  it("I6: checkout_prefill and action_buttons from a hand-off reach the widget callbacks", async () => {
    const data = { id: "pkg1", network: "MTN" }
    const buttons = [{ label: "Buy", href: "/b" }]
    const sse = [{ type: "text", content: "ok" }, { type: "checkout_prefill", data }, { type: "action_buttons", buttons }, { type: "done" }]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
    const prefills: unknown[] = []
    const btns: unknown[] = []
    const { ctrl, convs } = setup({ onCheckoutPrefill: (d) => prefills.push(d), onActionButtons: (b) => btns.push(b) }, sse)
    const p = ctrl.start("voice")
    await flush()
    convs[0].emit({ type: "avatar-presented" })
    convs[0].emitIface({ type: "session.delegation.created", delegation: { id: "d1", target: "client" } })
    await flush()
    await flush()
    expect(prefills).toEqual([data])
    expect(btns).toEqual([buttons])
    // a hang-up before the answer arrives must not push stale UI: nothing more after the call ended
    ctrl.hangUp()
    convs[0].resolveConnect()
    await p
  })

  it("I4: pageHide hangs up at once, posting the end with the auth header cached at start", async () => {
    const convs: any[] = []
    const ends: Array<{ body: any; headers: any }> = []
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url === "/api/ai/voice/token") return new Response(JSON.stringify({ token: "t", callId: "call-1", maxSeconds: 300 }), { status: 200 })
      ends.push({ body: JSON.parse(init.body), headers: init.headers })
      return new Response(null, { status: 204 })
    })
    const ctrl = createCallController({
      context: "dashboard",
      assistantName: () => "Clings",
      authHeader: async () => "Bearer jwt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSdk: async () => ({ createNuanceConversation: () => { const c = fakeConv("c1"); convs.push(c); return c } }) as any,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    const p = ctrl.start("voice")
    await flush()
    convs[0].emit({ type: "avatar-presented" })
    ctrl.pageHide()
    // synchronous: no await needed for the end request to have been issued
    expect(ends).toHaveLength(1)
    expect(ends[0].body).toMatchObject({ callId: "call-1", reason: "page_left", started: true })
    expect(ends[0].headers.Authorization).toBe("Bearer jwt")
    expect(ctrl.getSnapshot().state).toBe("ended")
    convs[0].resolveConnect()
    await p
  })
})

describe("waiting line", () => {
  type Reply = Record<string, unknown>
  function setupQ(opts: { tokens: Reply[]; polls?: Reply[]; pollStatus?: number; pollGate?: ReturnType<typeof deferred<void>>; secondTokenGate?: ReturnType<typeof deferred<void>> }) {
    const convs: any[] = []
    const tokenBodies: any[] = []
    const queueCalls: Array<{ body: any; headers: any; keepalive?: boolean }> = []
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    let tokenN = 0
    let pollN = 0
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url === "/api/ai/voice/token") {
        tokenBodies.push(JSON.parse(init.body))
        if (tokenN >= 1 && opts.secondTokenGate) await opts.secondTokenGate.promise
        return new Response(JSON.stringify(opts.tokens[Math.min(tokenN++, opts.tokens.length - 1)]), { status: 200 })
      }
      if (url === "/api/ai/voice/queue") {
        const body = JSON.parse(init.body)
        queueCalls.push({ body, headers: init.headers, keepalive: init.keepalive })
        if (body.action === "leave") return new Response(null, { status: 204 })
        if (opts.pollGate) await opts.pollGate.promise
        if (opts.pollStatus && opts.pollStatus !== 200) return new Response(JSON.stringify({ error: "x" }), { status: opts.pollStatus })
        const reply = (opts.polls ?? [])[Math.min(pollN++, (opts.polls ?? []).length - 1)] ?? { status: "waiting", position: 1, etaSeconds: 180 }
        return new Response(JSON.stringify(reply), { status: 200 })
      }
      if (url === "/api/ai/voice/end") return new Response(null, { status: 204 })
      throw new Error("unexpected " + url)
    })
    const ctrl = createCallController({
      context: "dashboard",
      assistantName: () => "Clings",
      authHeader: async () => "Bearer jwt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSdk: async () => ({ createNuanceConversation: () => { const c = fakeConv(`c${convs.length + 1}`); convs.push(c); return c } }) as any,
      setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1 },
      clearInterval: (h: unknown) => { timers[h as number].cleared = true },
    })
    const poll = async () => {
      timers.filter((t) => t.ms === 5000 && !t.cleared).forEach((t) => t.fn())
      await flush()
    }
    const pollTimers = () => timers.filter((t) => t.ms === 5000 && !t.cleared)
    return { ctrl, convs, tokenBodies, queueCalls, poll, pollTimers, fetchImpl }
  }
  const QUEUED = { queued: true, ticketId: "t-1", position: 2, etaSeconds: 360 }
  const GRANTED = { token: "tok", callId: "call-9", maxSeconds: 300 }

  it("a queued reply puts the call in the queued state with its place, and creates no conversation", async () => {
    const { ctrl, convs, pollTimers } = setupQ({ tokens: [QUEUED] })
    await ctrl.start("voice")
    expect(ctrl.getSnapshot()).toMatchObject({ state: "queued", mode: "voice", queue: { position: 2, etaSeconds: 360 } })
    expect(convs).toHaveLength(0)
    expect(pollTimers()).toHaveLength(1)
  })

  it("polls every 5 s with the ticket and shows the new place", async () => {
    const { ctrl, poll, queueCalls } = setupQ({ tokens: [QUEUED], polls: [{ status: "waiting", position: 1, etaSeconds: 180 }] })
    await ctrl.start("voice")
    await poll()
    expect(queueCalls[0].body).toEqual({ ticketId: "t-1" })
    expect(queueCalls[0].headers.Authorization).toBe("Bearer jwt")
    expect(ctrl.getSnapshot()).toMatchObject({ state: "queued", queue: { position: 1, etaSeconds: 180 } })
  })

  it("admitted: asks for the token again with the same mode and the ticket, then connects like a normal call", async () => {
    const { ctrl, convs, tokenBodies, poll, pollTimers } = setupQ({ tokens: [QUEUED, GRANTED], polls: [{ status: "admitted", position: 0, etaSeconds: 0 }] })
    await ctrl.start("video")
    await poll()
    expect(tokenBodies).toHaveLength(2)
    expect(tokenBodies[1]).toMatchObject({ context: "dashboard", mode: "video", ticketId: "t-1" })
    expect(tokenBodies[0].ticketId).toBeUndefined()
    expect(pollTimers()).toHaveLength(0) // polling stopped
    expect(convs).toHaveLength(1)
    expect(ctrl.getSnapshot()).toMatchObject({ state: "starting", mode: "video" })
    expect(ctrl.getSnapshot().queue).toBeUndefined()
    convs[0].emit({ type: "avatar-presented" })
    expect(ctrl.getSnapshot().state).toBe("live")
    convs[0].resolveConnect()
    await flush()
  })

  it("admitted but the token then says credits gone: back to idle with the closed-for-today line", async () => {
    const { ctrl, poll } = setupQ({ tokens: [QUEUED, { fallback: "text", reason: "credits" }], polls: [{ status: "admitted" }] })
    await ctrl.start("voice")
    await poll()
    expect(ctrl.getSnapshot()).toMatchObject({ state: "idle", endMessage: "Calls are closed for today. You can keep chatting here." })
  })

  it("expired: back to idle with the place-in-line-expired line and no more polling", async () => {
    const { ctrl, poll, pollTimers } = setupQ({ tokens: [QUEUED], polls: [{ status: "expired" }] })
    await ctrl.start("voice")
    await poll()
    expect(ctrl.getSnapshot()).toMatchObject({ state: "idle", endMessage: "Your place in line expired. Tap to try again." })
    expect(pollTimers()).toHaveLength(0)
  })

  it("a ticket the server no longer knows (404) ends the wait the same way", async () => {
    const { ctrl, poll } = setupQ({ tokens: [QUEUED], pollStatus: 404 })
    await ctrl.start("voice")
    await poll()
    expect(ctrl.getSnapshot()).toMatchObject({ state: "idle", endMessage: "Your place in line expired. Tap to try again." })
  })

  it("a failed poll (server error) keeps waiting and tries again next time", async () => {
    const { ctrl, poll } = setupQ({ tokens: [QUEUED], pollStatus: 503 })
    await ctrl.start("voice")
    await poll()
    expect(ctrl.getSnapshot().state).toBe("queued")
  })

  it("hang up while queued posts leave exactly once (keepalive), stops polling and goes idle", async () => {
    const { ctrl, queueCalls, poll, pollTimers } = setupQ({ tokens: [QUEUED] })
    await ctrl.start("voice")
    ctrl.hangUp()
    ctrl.hangUp()
    await flush()
    expect(queueCalls.filter((c) => c.body.action === "leave")).toHaveLength(1)
    expect(queueCalls[0]).toMatchObject({ body: { ticketId: "t-1", action: "leave" }, keepalive: true })
    expect(ctrl.getSnapshot().state).toBe("idle")
    expect(pollTimers()).toHaveLength(0)
    await poll()
    expect(queueCalls).toHaveLength(1)
  })

  it("stale generation: a poll answer that arrives after hang up does nothing (no token, no conversation)", async () => {
    const gate = deferred<void>()
    const { ctrl, convs, tokenBodies, poll } = setupQ({ tokens: [QUEUED, GRANTED], polls: [{ status: "admitted" }], pollGate: gate })
    await ctrl.start("voice")
    await poll() // the poll is now waiting on its answer
    ctrl.hangUp()
    gate.resolve()
    await flush()
    await flush()
    expect(tokenBodies).toHaveLength(1)
    expect(convs).toHaveLength(0)
    expect(ctrl.getSnapshot().state).toBe("idle")
  })

  it("review fix 6: hang up after admission while the token request is in flight gives the admitted place back (once)", async () => {
    const gate = deferred<void>()
    const { ctrl, convs, queueCalls, poll } = setupQ({ tokens: [QUEUED, GRANTED], polls: [{ status: "admitted" }], secondTokenGate: gate })
    await ctrl.start("voice")
    await poll() // admitted -> second token request now waiting
    ctrl.hangUp()
    gate.resolve()
    await flush()
    await flush()
    expect(queueCalls.filter((c) => c.body.action === "leave" && c.body.ticketId === "t-1")).toHaveLength(1)
    expect(convs).toHaveLength(0)
  })

  it("page hide while queued leaves the line at once with the cached auth header", async () => {
    const { ctrl, queueCalls } = setupQ({ tokens: [QUEUED] })
    await ctrl.start("voice")
    ctrl.pageHide()
    // synchronous: no await needed for the leave request to have been issued
    expect(queueCalls).toHaveLength(1)
    expect(queueCalls[0]).toMatchObject({ body: { ticketId: "t-1", action: "leave" }, keepalive: true })
    expect(queueCalls[0].headers.Authorization).toBe("Bearer jwt")
    expect(ctrl.getSnapshot().state).toBe("idle")
  })

  it("unmount (dispose) while queued also leaves the line", async () => {
    const { ctrl, queueCalls, pollTimers } = setupQ({ tokens: [QUEUED] })
    await ctrl.start("voice")
    ctrl.dispose()
    expect(queueCalls.filter((c) => c.body.action === "leave")).toHaveLength(1)
    expect(pollTimers()).toHaveLength(0)
  })

  it("a second start while queued does nothing", async () => {
    const { ctrl, tokenBodies } = setupQ({ tokens: [QUEUED] })
    await ctrl.start("voice")
    await ctrl.start("video")
    expect(tokenBodies).toHaveLength(1)
    expect(ctrl.getSnapshot().mode).toBe("voice")
  })

  it("after leaving, the caller can start again", async () => {
    const { ctrl, tokenBodies } = setupQ({ tokens: [QUEUED, GRANTED] })
    await ctrl.start("voice")
    ctrl.hangUp()
    await flush()
    void ctrl.start("voice")
    await flush()
    expect(tokenBodies).toHaveLength(2)
    expect(tokenBodies[1].ticketId).toBeUndefined()
  })
})
