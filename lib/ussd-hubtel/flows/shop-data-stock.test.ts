// Shop codes: a network the admin marked out of stock stays in the shop's list (only if the shop sells it)
// and shows the admin's reason when picked.
import { describe, it, expect } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeShop, fakeSupabase, makeDeps, OK_PKG, req, SHOP_CONFIG } from "../testing/fakes"

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

  it("picking the out-of-stock network shows the reason and stays on the network menu", async () => {
    let bundleCalls = 0
    const { deps, store } = shopDeps({
      shop: fakeShop({
        networks: async () => ["Telecel"],
        soldNetworks: async () => ["Telecel", "MTN"],
        bundles: async () => { bundleCalls++; return [{ id: "pkg-1", size: "5", price: 12 }] },
      }),
      stockNotices: async () => ({ MTN: "MTN delays, back by 6pm" }),
    })
    await toNetworks(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("MTN delays, back by 6pm\nAma Data Hub\nSelect Network:\n1. MTN\n2. Telecel\n0. Back")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_NETWORK")
    expect(bundleCalls).toBe(0)
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
