import { describe, expect, it, vi } from "vitest"
import { resolveShopForText, type ShopResolveDeps } from "./resolve"

const S = "0200000101"
const mkShop = (code: string, over: Record<string, unknown> = {}) => ({
  shopCodeId: `id-${code}`, shopId: `shop-${code}`, shopName: `Shop ${code}`, parentShopId: null as string | null,
  status: "active", tokenBalance: 0, whatsappActivated: false, ownerPhone: "0240000001" as string | null, ...over,
})

function mk(opts: { codes?: Record<string, ReturnType<typeof mkShop>>; pref?: string | null; last?: string | null } = {}) {
  const codes = opts.codes ?? {}
  const byId = new Map(Object.values(codes).map((s) => [s.shopCodeId, s]))
  const deps = {
    resolveShopCode: vi.fn(async (code: string) => codes[code] ?? null),
    getShopPref: vi.fn(async () => (opts.pref ? { shopCodeId: opts.pref } : null)),
    setShopPref: vi.fn(async () => {}),
    lastBoughtShopCodeId: vi.fn(async () => opts.last ?? null),
    shopCodeById: vi.fn(async (id: string) => byId.get(id) ?? null),
  }
  return { deps: deps as unknown as ShopResolveDeps & typeof deps }
}

describe("resolveShopForText", () => {
  it("a valid code in the text wins and builds the ShopRef", async () => {
    const { deps } = mk({ codes: { kofi123: mkShop("kofi123", { parentShopId: "p1" }) } })
    const r = await resolveShopForText(deps, { sender: S, text: "kofi123 5gb 0241234567" })
    expect(r).toEqual({
      kind: "shop", via: "code",
      shop: { shopCodeId: "id-kofi123", shopId: "shop-kofi123", parentShopId: "p1", name: "Shop kofi123", helpline: "0240000001" },
    })
    expect(deps.getShopPref).not.toHaveBeenCalled()
    expect(deps.setShopPref).not.toHaveBeenCalled()
  })

  it("a new valid code beats the pref and the last purchase", async () => {
    const { deps } = mk({ codes: { newone: mkShop("newone"), oldone: mkShop("oldone") }, pref: "id-oldone", last: "id-oldone" })
    const r = await resolveShopForText(deps, { sender: S, text: "newone 2gb" })
    expect(r).toMatchObject({ kind: "shop", via: "code", shop: { shopCodeId: "id-newone" } })
  })

  it("a null ownerPhone gives a null helpline", async () => {
    const { deps } = mk({ codes: { kofi123: mkShop("kofi123", { ownerPhone: null }) } })
    const r = await resolveShopForText(deps, { sender: S, text: "kofi123" })
    expect(r).toMatchObject({ kind: "shop", shop: { helpline: null } })
  })

  it("two candidates where only the second resolves", async () => {
    const { deps } = mk({ codes: { second1: mkShop("second1") } })
    const r = await resolveShopForText(deps, { sender: S, text: "first11 second1 5gb" })
    expect(r).toMatchObject({ kind: "shop", via: "code", shop: { shopCodeId: "id-second1" } })
    expect(deps.resolveShopCode.mock.calls.map((c) => c[0])).toEqual(["first11", "second1"])
  })

  it("the AI candidate is tried last", async () => {
    const { deps } = mk({ codes: { aicode1: mkShop("aicode1"), text123: mkShop("text123") } })
    const both = await resolveShopForText(deps, { sender: S, text: "text123 5gb", aiCandidate: "aicode1" })
    expect(both).toMatchObject({ shop: { shopCodeId: "id-text123" } })
    const only = await resolveShopForText(deps, { sender: S, text: "5gb please", aiCandidate: "aicode1" })
    expect(only).toMatchObject({ kind: "shop", via: "code", shop: { shopCodeId: "id-aicode1" } })
  })

  it("an AI candidate that repeats a text token is looked up once; a bad AI candidate is ignored", async () => {
    const { deps } = mk({ codes: {} })
    await resolveShopForText(deps, { sender: S, text: "kofi123", aiCandidate: "kofi123" })
    expect(deps.resolveShopCode).toHaveBeenCalledTimes(1)
    const bad = mk({ pref: null })
    const r = await resolveShopForText(bad.deps, { sender: S, text: "5gb", aiCandidate: "5gb" })
    expect(r).toEqual({ kind: "ask" })
    expect(bad.deps.resolveShopCode).not.toHaveBeenCalled()
  })

  it("a phone number and a size are never looked up as codes", async () => {
    const { deps } = mk()
    const r = await resolveShopForText(deps, { sender: S, text: "5gb 0241234567" })
    expect(r).toEqual({ kind: "ask" })
    expect(deps.resolveShopCode).not.toHaveBeenCalled()
  })

  it("an unknown code is not_found and does not fall to the pref or last purchase", async () => {
    const { deps } = mk({ codes: { good123: mkShop("good123") }, pref: "id-good123", last: "id-good123" })
    const r = await resolveShopForText(deps, { sender: S, text: "nosuch1 5gb" })
    expect(r).toEqual({ kind: "not_found" })
    expect(deps.getShopPref).not.toHaveBeenCalled()
    expect(deps.lastBoughtShopCodeId).not.toHaveBeenCalled()
  })

  it("a code that resolves to a shop that is not active is closed", async () => {
    for (const status of ["inactive", "suspended", "blocked"]) {
      const { deps } = mk({ codes: { shut123: mkShop("shut123", { status }) } })
      const r = await resolveShopForText(deps, { sender: S, text: "shut123 5gb" })
      expect(r).toMatchObject({ kind: "closed", shop: { shopCodeId: "id-shut123", helpline: "0240000001" } })
    }
  })

  it("with no code the pref is used", async () => {
    const { deps } = mk({ codes: { pref123: mkShop("pref123") }, pref: "id-pref123" })
    const r = await resolveShopForText(deps, { sender: S, text: "5gb 0241234567" })
    expect(r).toMatchObject({ kind: "shop", via: "pref", shop: { shopCodeId: "id-pref123" } })
    expect(deps.lastBoughtShopCodeId).not.toHaveBeenCalled()
    expect(deps.setShopPref).not.toHaveBeenCalled()
  })

  it("a pref shop that is no longer active is closed, never another shop", async () => {
    const { deps } = mk({
      codes: { pref123: mkShop("pref123", { status: "suspended" }), last123: mkShop("last123") },
      pref: "id-pref123", last: "id-last123",
    })
    const r = await resolveShopForText(deps, { sender: S, text: "5gb" })
    expect(r).toMatchObject({ kind: "closed", shop: { shopCodeId: "id-pref123" } })
    expect(deps.lastBoughtShopCodeId).not.toHaveBeenCalled()
  })

  it("with no code and no pref the last purchase is used and seeds the pref once", async () => {
    const { deps } = mk({ codes: { last123: mkShop("last123") }, last: "id-last123" })
    const r = await resolveShopForText(deps, { sender: S, text: "5gb" })
    expect(r).toMatchObject({ kind: "shop", via: "last", shop: { shopCodeId: "id-last123" } })
    expect(deps.lastBoughtShopCodeId).toHaveBeenCalledWith(S)
    expect(deps.setShopPref).toHaveBeenCalledTimes(1)
    expect(deps.setShopPref).toHaveBeenCalledWith(S, "id-last123")
  })

  it("a last-purchase shop that is no longer active is closed and does not seed the pref", async () => {
    const { deps } = mk({ codes: { last123: mkShop("last123", { status: "inactive" }) }, last: "id-last123" })
    const r = await resolveShopForText(deps, { sender: S, text: "5gb" })
    expect(r).toMatchObject({ kind: "closed", shop: { shopCodeId: "id-last123" } })
    expect(deps.setShopPref).not.toHaveBeenCalled()
  })

  it("a last-purchase code that no longer exists asks", async () => {
    const { deps } = mk({ codes: {}, last: "id-gone" })
    expect(await resolveShopForText(deps, { sender: S, text: "5gb" })).toEqual({ kind: "ask" })
    expect(deps.setShopPref).not.toHaveBeenCalled()
  })

  it("with no code, pref or purchase it asks", async () => {
    const { deps } = mk()
    expect(await resolveShopForText(deps, { sender: S, text: "5gb 0241234567" })).toEqual({ kind: "ask" })
  })

  it("looks the code up exactly as written, without changing case", async () => {
    const { deps } = mk({ codes: { Kofi123: mkShop("Kofi123") } })
    expect(await resolveShopForText(deps, { sender: S, text: "kofi123" })).toEqual({ kind: "not_found" })
    expect(deps.resolveShopCode).toHaveBeenCalledWith("kofi123")
    expect(await resolveShopForText(deps, { sender: S, text: "Kofi123" })).toMatchObject({ kind: "shop" })
  })
})
