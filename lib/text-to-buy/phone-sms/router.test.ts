import { describe, it, expect, vi, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createReplySend } from "./router"
import { TTB_DEFAULTS, type TtbSettings } from "../settings"
import type { PhoneSendResult } from "./client"

const ENV = { SMS_PHONE_URL: "http://relay.example.test:7002", SMS_PHONE_SM4_KEY: "a1b2c3d4e5f60718293a4b5c6d7e8f90" } as unknown as NodeJS.ProcessEnv
const PAYLOAD = { phone: "0200000903", message: "private reply body", type: "text_to_buy_reply" as const, senderId: "Sender", skipLogging: true }
const NOW = new Date("2026-11-15T12:00:00.000Z")

type Count = { count: number | null; error: unknown }
function fakeDb(res: Count, seen: { table?: string; line?: string; direction?: string; since?: string } = {}): SupabaseClient {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = (col: string, v: string) => {
    if (col === "line") seen.line = v
    if (col === "direction") seen.direction = v
    return chain
  }
  chain.gte = (col: string, v: string) => {
    if (col === "created_at") seen.since = v
    return chain
  }
  chain.then = (ok: (r: Count) => unknown) => Promise.resolve(res).then(ok)
  return { from: (t: string) => ((seen.table = t), chain) } as unknown as SupabaseClient
}

function setup(o: {
  line?: "main" | "shop"
  transport?: "hubtel" | "sim"
  phone?: PhoneSendResult
  count?: Count
  env?: NodeJS.ProcessEnv
  hubtelRes?: { success: boolean; skipped?: boolean }
  settings?: Partial<TtbSettings>
}) {
  const line = o.line ?? "main"
  const hubtel = vi.fn(async (..._a: unknown[]) => o.hubtelRes ?? { success: true })
  const phone = vi.fn(async (..._a: unknown[]) => o.phone ?? ({ kind: "sent" } as PhoneSendResult))
  const seen: Record<string, string | undefined> = {}
  const settings = {
    ...TTB_DEFAULTS,
    replyTransportMain: o.transport ?? "sim",
    replyTransportShop: o.transport ?? "sim",
    ...o.settings,
  } as TtbSettings
  const send = createReplySend({
    db: fakeDb(o.count ?? { count: 0, error: null }, seen),
    line,
    settings,
    env: o.env ?? ENV,
    hubtel: hubtel as never,
    phone: phone as never,
    now: () => NOW,
  })
  return { send, hubtel, phone, seen }
}

afterEach(() => vi.restoreAllMocks())

describe("createReplySend", () => {
  it("transport hubtel: hubtel called, phone never", async () => {
    const t = setup({ transport: "hubtel" })
    expect(await t.send(PAYLOAD)).toEqual({ success: true })
    expect(t.hubtel).toHaveBeenCalledTimes(1)
    expect(t.phone).not.toHaveBeenCalled()
  })

  it("sim + sent: success, hubtel not called, payload reaches the phone", async () => {
    const t = setup({})
    expect(await t.send(PAYLOAD)).toEqual({ success: true })
    expect(t.hubtel).not.toHaveBeenCalled()
    const [cfg, p] = t.phone.mock.calls[0] as [{ url: string; keyHex: string }, { simSlot: number; to: string; text: string }]
    expect(cfg).toEqual({ url: ENV.SMS_PHONE_URL, keyHex: ENV.SMS_PHONE_SM4_KEY })
    expect(p).toMatchObject({ to: PAYLOAD.phone, text: PAYLOAD.message })
  })

  it("sim + refused or unreachable: hubtel called once with the original payload", async () => {
    for (const kind of ["refused", "unreachable"] as const) {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const t = setup({ phone: { kind } })
      expect(await t.send(PAYLOAD)).toEqual({ success: true })
      expect(t.hubtel).toHaveBeenCalledTimes(1)
      expect(t.hubtel.mock.calls[0][0]).toEqual(PAYLOAD)
    }
  })

  it("a throwing phone client is treated as unreachable and falls back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = setup({})
    const throwing = vi.fn(async () => { throw new Error("kaboom") })
    const send = createReplySend({
      db: fakeDb({ count: 0, error: null }), line: "main", settings: { ...TTB_DEFAULTS, replyTransportMain: "sim" }, env: ENV,
      hubtel: t.hubtel as never, phone: throwing as never, now: () => NOW,
    })
    expect(await send(PAYLOAD)).toEqual({ success: true })
    expect(t.hubtel).toHaveBeenCalledTimes(1)
  })

  it("sim + ambiguous: success and hubtel NOT called (no duplicate)", async () => {
    const t = setup({ phone: { kind: "ambiguous" } })
    expect(await t.send(PAYLOAD)).toEqual({ success: true })
    expect(t.hubtel).not.toHaveBeenCalled()
  })

  it("missing or malformed env goes to hubtel without calling the phone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const env of [
      {},
      { SMS_PHONE_URL: ENV.SMS_PHONE_URL },
      { SMS_PHONE_SM4_KEY: ENV.SMS_PHONE_SM4_KEY },
      { SMS_PHONE_URL: ENV.SMS_PHONE_URL, SMS_PHONE_SM4_KEY: "tooshort" },
      { SMS_PHONE_URL: "not a url", SMS_PHONE_SM4_KEY: ENV.SMS_PHONE_SM4_KEY },
    ] as unknown as NodeJS.ProcessEnv[]) {
      const t = setup({ env })
      await t.send(PAYLOAD)
      expect(t.hubtel).toHaveBeenCalledTimes(1)
      expect(t.phone).not.toHaveBeenCalled()
    }
  })

  it("cap reached (count >= cap) goes to hubtel; just under the cap uses the phone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const over = setup({ count: { count: 20, error: null } })
    await over.send(PAYLOAD)
    expect(over.hubtel).toHaveBeenCalledTimes(1)
    expect(over.phone).not.toHaveBeenCalled()
    const under = setup({ count: { count: 19, error: null } })
    await under.send(PAYLOAD)
    expect(under.phone).toHaveBeenCalledTimes(1)
    expect(under.hubtel).not.toHaveBeenCalled()
    const custom = setup({ count: { count: 5, error: null }, settings: { simMaxPer30Min: 5 } })
    await custom.send(PAYLOAD)
    expect(custom.hubtel).toHaveBeenCalledTimes(1)
  })

  it("a count query error is treated as over the cap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = setup({ count: { count: null, error: { message: "db down" } } })
    await t.send(PAYLOAD)
    expect(t.hubtel).toHaveBeenCalledTimes(1)
    expect(t.phone).not.toHaveBeenCalled()
  })

  it("counts outbound rows of this line in the last 30 minutes", async () => {
    const t = setup({ line: "shop" })
    await t.send(PAYLOAD)
    expect(t.seen).toMatchObject({ table: "ttb_messages", line: "shop", direction: "out", since: new Date(NOW.getTime() - 30 * 60_000).toISOString() })
  })

  it("maps main to simSlotMain and shop to simSlotShop, and reads each line's own transport", async () => {
    const main = setup({ line: "main", settings: { simSlotMain: 2, simSlotShop: 1 } })
    await main.send(PAYLOAD)
    expect((main.phone.mock.calls[0][1] as { simSlot: number }).simSlot).toBe(2)
    const shop = setup({ line: "shop", settings: { simSlotMain: 2, simSlotShop: 1 } })
    await shop.send(PAYLOAD)
    expect((shop.phone.mock.calls[0][1] as { simSlot: number }).simSlot).toBe(1)
    const mixed = setup({ line: "shop", settings: { replyTransportMain: "sim", replyTransportShop: "hubtel" } })
    await mixed.send(PAYLOAD)
    expect(mixed.phone).not.toHaveBeenCalled()
    expect(mixed.hubtel).toHaveBeenCalledTimes(1)
  })

  it("logs one fixed fallback line with a reason code and nothing sensitive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const t = setup({ phone: { kind: "refused" } })
    await t.send(PAYLOAD)
    const all = [...warn.mock.calls, ...err.mock.calls, ...log.mock.calls]
    expect(all).toHaveLength(1)
    const line = JSON.stringify(all[0])
    expect(line).toContain("refused")
    for (const secret of [PAYLOAD.phone, PAYLOAD.message, String(ENV.SMS_PHONE_URL), String(ENV.SMS_PHONE_SM4_KEY), "relay.example.test"]) {
      expect(line).not.toContain(secret)
    }
  })

  it("passes a hubtel skipped result through unchanged", async () => {
    const t = setup({ transport: "hubtel", hubtelRes: { success: true, skipped: true } })
    expect(await t.send(PAYLOAD)).toEqual({ success: true, skipped: true })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = setup({ phone: { kind: "unreachable" }, hubtelRes: { success: true, skipped: true } })
    expect(await f.send(PAYLOAD)).toEqual({ success: true, skipped: true })
  })
})
