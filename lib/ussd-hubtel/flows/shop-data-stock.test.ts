// Shop codes: a network the admin marked out of stock stays in the shop's list (only if the shop sells it)
// and shows the admin's reason when picked.
import { describe, it, expect } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeShop, fakeSupabase, makeDeps, OK_PKG, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"
import { USSD_SCREEN_LIMIT } from "../protocol"

async function toNetworks(deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  const menu = await hubtelRouter(req({ Message: "1234" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Internet Bundles") }), deps)
}
const shopDeps = (over: Parameters<typeof makeDeps>[0] = {}) =>
  makeDeps({ getConfig: SHOP_CONFIG, ...over }, fakeSupabase({ pkg: OK_PKG }))

describe("shop codes: out-of-stock reason", () => {
  it("keeps an out-of-stock network the shop sells in the network list", async () => {
    const { deps } = shopDeps({
      shop: fakeShop({ networks: async () => ["Telecel"], soldNetworks: async () => ["Telecel", "MTN"] }),
      stockNotices: async () => ({ MTN: "MTN delays" }),
    })
    const r = await toNetworks(deps)
    expect(r.Message).toBe("Ama Data Hub\nSelect Network:\n1. MTN\n2. Telecel\n0. Back")
  })

  it("does not add a network the shop does not sell", async () => {
    const { deps } = shopDeps({
      shop: fakeShop({ networks: async () => ["Telecel"], soldNetworks: async () => ["Telecel"] }),
      stockNotices: async () => ({ MTN: "MTN delays" }),
    })
    const r = await toNetworks(deps)
    expect(r.Message).toBe("Ama Data Hub\nSelect Network:\n1. Telecel\n0. Back")
  })

  it("lists the networks even when every one the shop sells is out of stock", async () => {
    const { deps, store } = shopDeps({
      shop: fakeShop({ networks: async () => [], soldNetworks: async () => ["MTN"] }),
      stockNotices: async () => ({ MTN: "MTN delays" }),
    })
    const r = await toNetworks(deps)
    expect(r.Message).toBe("Ama Data Hub\nSelect Network:\n1. MTN\n0. Back")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_NETWORK")
  })

  it("picking the out-of-stock network (no bundles) shows the reason and stays on the network menu", async () => {
    const { deps, store } = shopDeps({
      shop: fakeShop({ networks: async () => ["Telecel"], soldNetworks: async () => ["Telecel", "MTN"], bundles: async () => [] }),
      stockNotices: async () => ({ MTN: "MTN delays, back by 6pm" }),
    })
    await toNetworks(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("MTN delays, back by 6pm\nAma Data Hub\nSelect Network:\n1. MTN\n2. Telecel\n0. Back")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_NETWORK")
  })

  it("still lists bundles the admin re-enabled while the network is flagged (partial restock)", async () => {
    const { deps, store } = shopDeps({
      shop: fakeShop({ networks: async () => ["MTN"], soldNetworks: async () => ["MTN"] }),
      stockNotices: async () => ({ MTN: "MTN delays" }),
    })
    await toNetworks(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("Select Package")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_BUNDLE")
  })

  it("a 100-char reason on a long-named shop with 4 networks fits one screen and keeps '0. Back'", async () => {
    const longName = { ...SHOP_CODE, shopName: "A".repeat(40) }
    const all = ["MTN", "Telecel", "AT-iShare", "AT-BigTime"]
    const { deps } = shopDeps({
      shop: fakeShop({
        resolveCode: async code => (code === "1234" ? longName : null),
        networks: async () => [], soldNetworks: async () => all, bundles: async () => [],
      }),
      stockNotices: async () => ({ MTN: "x".repeat(100), Telecel: "y", "AT - iShare": "z", "AT - BigTime": "w" }),
    })
    await toNetworks(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(r.Message.endsWith("0. Back")).toBe(true)
    expect(r.Message.startsWith("xxxxx")).toBe(true)
  })

  it("fails open: notice or sold-network errors give today's list and messages", async () => {
    const { deps } = shopDeps({
      shop: fakeShop({ networks: async () => ["MTN"], soldNetworks: async () => { throw new Error("db") }, bundles: async () => [] }),
      stockNotices: async () => { throw new Error("db") },
    })
    const list = await toNetworks(deps)
    expect(list.Message).toBe("Ama Data Hub\nSelect Network:\n1. MTN\n0. Back")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("No MTN packages available.")
  })
})
