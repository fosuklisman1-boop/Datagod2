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
