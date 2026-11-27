import { beforeEach, describe, expect, it, vi } from "vitest"
import { createCallController, resetBlockedForTests, type SdkLike } from "./call-controller"

type Handler = (ev: any) => void

function fakeConv(id: string) {
  const changeHandlers: Handler[] = []
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
    onInterfaceEvent: () => () => {},
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

function setup() {
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
})
