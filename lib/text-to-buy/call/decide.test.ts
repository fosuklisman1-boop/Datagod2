import { afterEach, describe, expect, it, vi } from "vitest"
import { TTB_DEFAULTS } from "../settings"
import { handleMissedCall, type CallDeps } from "./decide"

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0)
const SHOP = { shopCodeId: "c1", shopId: "s1", shopName: "Kofi Data", parentShopId: null, status: "active", tokenBalance: 0, whatsappActivated: false, ownerPhone: "0244000111" }

function makeDeps(over: Partial<CallDeps> = {}) {
  const sent: Array<{ sender: string; body: string; payer?: unknown; line: string }> = []
  const deps = {
    settings: { ...TTB_DEFAULTS, callsEnabled: true, callsPerHourPerLine: 60, shopRepliesPerHourPerShop: 10 },
    normalizeSender: vi.fn((raw: string) => (/^0\d{9}$/.test(raw) ? raw : null)),
    isBlocked: vi.fn(async () => false),
    noticeOnce: vi.fn(async () => true),
    repliedCallsLastHour: vi.fn(async () => 0),
    getShopPref: vi.fn(async () => null as { shopCodeId: string } | null),
    lastBoughtShopCodeId: vi.fn(async () => null as string | null),
    shopCodeById: vi.fn(async () => SHOP as typeof SHOP | null),
    shopAccountFor: vi.fn(async () => ({ accountId: "a1" }) as { accountId: string } | null),
    shopReplyCapReached: vi.fn(async () => false),
    sendReply: vi.fn(async (r: { sender: string; body: string; payer?: unknown; line: string }) => {
      sent.push(r)
      return { sent: true } as { sent: boolean; skipped?: boolean | "unpaid" }
    }),
    readSupportWhatsapp: vi.fn(async () => "233559919037" as string | null),
    logCall: vi.fn(async () => {}),
    alertAdmin: vi.fn(async () => {}),
    ...over,
  } as unknown as CallDeps & { [k: string]: ReturnType<typeof vi.fn> | unknown }
  return { deps: deps as CallDeps, raw: deps as unknown as Record<string, ReturnType<typeof vi.fn>>, sent }
}
const input = (o: Partial<{ line: "main" | "shop"; fromRaw: string; receivedMs: number | null }> = {}) => ({
  line: "shop" as const, fromRaw: "0551234567", receivedMs: NOW - 1000, nowMs: NOW, ...o,
})
const outcomes = (raw: Record<string, ReturnType<typeof vi.fn>>) => raw.logCall.mock.calls.map((c) => (c[0] as { outcome: string }).outcome)

afterEach(() => vi.restoreAllMocks())

describe("handleMissedCall ordering", () => {
  it("switch off: skipped_off, nothing else touched", async () => {
    const { deps, raw, sent } = makeDeps({ settings: { ...TTB_DEFAULTS, callsEnabled: false } })
    expect((await handleMissedCall(deps, input())).outcome).toBe("skipped_off")
    expect(raw.noticeOnce).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
    expect(outcomes(raw)).toEqual(["skipped_off"])
  })

  it("invalid caller: skipped_invalid before staleness and blocked", async () => {
    const { deps, raw } = makeDeps()
    expect((await handleMissedCall(deps, input({ fromRaw: "MTN", receivedMs: NOW - 99 * 60_000 }))).outcome).toBe("skipped_invalid")
    expect(raw.isBlocked).not.toHaveBeenCalled()
  })

  it("stale beyond 15 minutes; null received uses now", async () => {
    const a = makeDeps()
    expect((await handleMissedCall(a.deps, input({ receivedMs: NOW - 15 * 60_000 - 1 }))).outcome).toBe("skipped_stale")
    expect(a.raw.isBlocked).not.toHaveBeenCalled()
    const b = makeDeps()
    expect((await handleMissedCall(b.deps, input({ receivedMs: null }))).outcome).toBe("replied_support")
    const c = makeDeps()
    expect((await handleMissedCall(c.deps, input({ receivedMs: NOW - 15 * 60_000 }))).outcome).not.toBe("skipped_stale")
  })

  it("blocked caller: skipped_blocked, no marker", async () => {
    const { deps, raw, sent } = makeDeps({ isBlocked: vi.fn(async () => true) })
    expect((await handleMissedCall(deps, input())).outcome).toBe("skipped_blocked")
    expect(raw.noticeOnce).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it("daily marker taken: skipped_duplicate, sends nothing; marker kind and day are per line", async () => {
    const { deps, raw, sent } = makeDeps({ noticeOnce: vi.fn(async () => false) })
    expect((await handleMissedCall(deps, input({ line: "main" }))).outcome).toBe("skipped_duplicate")
    expect(sent).toHaveLength(0)
    expect(raw.noticeOnce).toHaveBeenCalledWith("call_main", "0551234567", null, "2026-11-15")
    expect(raw.repliedCallsLastHour).not.toHaveBeenCalled()
  })

  it("hourly line cap: skipped_cap (marker already taken, no send)", async () => {
    const { deps, raw, sent } = makeDeps({ repliedCallsLastHour: vi.fn(async () => 60) })
    expect((await handleMissedCall(deps, input())).outcome).toBe("skipped_cap")
    expect(raw.noticeOnce).toHaveBeenCalledWith("call_shop", "0551234567", null, "2026-11-15")
    expect(raw.repliedCallsLastHour).toHaveBeenCalledWith("shop")
    expect(sent).toHaveLength(0)
  })

  it("support number missing: no send, exactly one alert, outcome error, no number in the alert", async () => {
    const { deps, raw, sent } = makeDeps({ readSupportWhatsapp: vi.fn(async () => null) })
    expect((await handleMissedCall(deps, input({ line: "main" }))).outcome).toBe("error")
    expect(sent).toHaveLength(0)
    expect(raw.alertAdmin).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(raw.alertAdmin.mock.calls)).not.toMatch(/\d{6}/)
    expect(outcomes(raw)).toEqual(["error"])
  })
})

describe("handleMissedCall main line", () => {
  it("sends the support SMS, never touches shop deps", async () => {
    const { deps, raw, sent } = makeDeps()
    expect((await handleMissedCall(deps, input({ line: "main" }))).outcome).toBe("replied_main")
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toBe("Sorry we missed your call. For help WhatsApp us: https://wa.me/233559919037")
    expect(sent[0].line).toBe("main")
    expect(sent[0].payer).toBeUndefined()
    for (const k of ["getShopPref", "lastBoughtShopCodeId", "shopCodeById", "shopAccountFor", "shopReplyCapReached"]) expect(raw[k]).not.toHaveBeenCalled()
    expect(raw.logCall).toHaveBeenCalledWith({ line: "main", sender: "0551234567", shopId: null, outcome: "replied_main" })
  })
})

describe("handleMissedCall shop line", () => {
  it("linked caller with credits: shop-owner copy through the shop payer", async () => {
    const { deps, raw, sent } = makeDeps({ getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })) })
    expect((await handleMissedCall(deps, input())).outcome).toBe("replied_shop")
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toBe("Sorry we missed your call. Please contact Kofi Data on 0244000111.")
    expect(sent[0].payer).toEqual({ kind: "shop", shopId: "s1", accountId: "a1", messageId: null, replyKey: "call-2026-11-15-0551234567" })
    expect(raw.logCall).toHaveBeenCalledWith({ line: "shop", sender: "0551234567", shopId: "s1", outcome: "replied_shop" })
    expect(raw.lastBoughtShopCodeId).not.toHaveBeenCalled()
  })

  it("falls to last bought when there is no pref", async () => {
    const { deps, sent } = makeDeps({ lastBoughtShopCodeId: vi.fn(async () => "c1") })
    expect((await handleMissedCall(deps, input())).outcome).toBe("replied_shop")
    expect(sent[0].body).toContain("Kofi Data")
  })

  it("unpaid: exactly one support SMS and one marker", async () => {
    const calls: unknown[] = []
    const { deps, raw } = makeDeps({
      getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })),
      sendReply: vi.fn(async (r: { payer?: { kind: string } }) => {
        calls.push(r)
        return r.payer?.kind === "shop" ? { sent: false, skipped: "unpaid" as const } : { sent: true }
      }),
    })
    expect((await handleMissedCall(deps, input())).outcome).toBe("replied_support")
    expect(calls).toHaveLength(2)
    const second = calls[1] as { body: string; payer?: unknown }
    expect(second.body).toContain("wa.me/233559919037")
    expect(second.payer).toBeUndefined()
    expect(raw.noticeOnce).toHaveBeenCalledTimes(1)
    expect(raw.logCall).toHaveBeenCalledWith({ line: "shop", sender: "0551234567", shopId: null, outcome: "replied_support" })
  })

  it("closed, not linked, no account, no helpline, per-shop cap: support SMS once, no shop payer attempted", async () => {
    const cases: Array<Partial<CallDeps>> = [
      { getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })), shopCodeById: vi.fn(async () => ({ ...SHOP, status: "suspended" })) },
      {},
      { getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })), shopAccountFor: vi.fn(async () => null) },
      { getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })), shopCodeById: vi.fn(async () => ({ ...SHOP, ownerPhone: null })) },
      { getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })), shopReplyCapReached: vi.fn(async () => true) },
      { getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })), shopCodeById: vi.fn(async () => null) },
      { getShopPref: vi.fn(async () => { throw new Error("db") }) },
    ]
    for (const c of cases) {
      const { deps, sent } = makeDeps(c)
      expect((await handleMissedCall(deps, input())).outcome).toBe("replied_support")
      expect(sent).toHaveLength(1)
      expect(sent[0].payer).toBeUndefined()
      expect(sent[0].body).toContain("wa.me/")
    }
  })

  it("a pref that does not resolve is final: last bought is not consulted", async () => {
    const { deps, raw } = makeDeps({ getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })), shopCodeById: vi.fn(async () => null), lastBoughtShopCodeId: vi.fn(async () => "c2") })
    await handleMissedCall(deps, input())
    expect(raw.lastBoughtShopCodeId).not.toHaveBeenCalled()
  })
})

describe("handleMissedCall failures", () => {
  it("a sent:false or thrown send logs error and never retries", async () => {
    for (const impl of [vi.fn(async () => ({ sent: false })), vi.fn(async () => { throw new Error("boom 0551234567") })]) {
      const { deps, raw } = makeDeps({ sendReply: impl as never })
      expect((await handleMissedCall(deps, input({ line: "main" }))).outcome).toBe("error")
      expect(impl).toHaveBeenCalledTimes(1)
      expect(outcomes(raw)).toEqual(["error"])
    }
  })

  it("a failed support send after unpaid is error, not retried", async () => {
    const impl = vi.fn(async (r: { payer?: { kind: string } }) => (r.payer?.kind === "shop" ? { sent: false, skipped: "unpaid" as const } : { sent: false }))
    const { deps } = makeDeps({ getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })), sendReply: impl as never })
    expect((await handleMissedCall(deps, input())).outcome).toBe("error")
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it("a failed shop-paid send (not unpaid) is error and does not fall back to support", async () => {
    const impl = vi.fn(async () => ({ sent: false }))
    const { deps } = makeDeps({ getShopPref: vi.fn(async () => ({ shopCodeId: "c1" })), sendReply: impl as never })
    expect((await handleMissedCall(deps, input())).outcome).toBe("error")
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it("a throwing dependency before the send yields error, no send, and never throws", async () => {
    const { deps, sent, raw } = makeDeps({ noticeOnce: vi.fn(async () => { throw new Error("x") }) })
    expect((await handleMissedCall(deps, input())).outcome).toBe("error")
    expect(sent).toHaveLength(0)
    expect(outcomes(raw)).toEqual(["error"])
  })

  it("a failing logCall never throws out of the handler", async () => {
    const { deps } = makeDeps({ logCall: vi.fn(async () => { throw new Error("x") }) })
    expect((await handleMissedCall(deps, input({ line: "main" }))).outcome).toBe("replied_main")
  })

  it("leaks no phone number or text to console or alerts", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")].map((s) => s.mockImplementation(() => {}))
    const { deps, raw } = makeDeps({ sendReply: vi.fn(async () => { throw new Error("boom 0551234567") }) as never })
    await handleMissedCall(deps, input({ line: "main" }))
    const { deps: d2, raw: r2 } = makeDeps({ readSupportWhatsapp: vi.fn(async () => null) })
    await handleMissedCall(d2, input())
    const all = JSON.stringify([...spies.map((s) => s.mock.calls), raw.alertAdmin.mock.calls, r2.alertAdmin.mock.calls])
    expect(all).not.toMatch(/0551234567|233559919037/)
  })
})
