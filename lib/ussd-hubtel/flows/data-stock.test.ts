// Main-code data flow: a network the admin marked out of stock shows the admin's reason.
import { describe, it, expect } from "vitest"
import { hubtelRouter } from "../router"
import { networkMenuText } from "../menus"
import { USSD_SCREEN_LIMIT } from "../protocol"
import { makeDeps, req } from "../testing/fakes"

async function pickNetwork(digit: string, deps: Parameters<typeof hubtelRouter>[1]) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  await hubtelRouter(req({ Message: "1" }), deps) // data
  return hubtelRouter(req({ Message: digit }), deps)
}

describe("main data flow: out-of-stock reason", () => {
  it("shows the reason above the network menu and does not list bundles", async () => {
    let bundleCalls = 0
    const { deps, store } = makeDeps({
      stockNotices: async () => ({ MTN: "MTN delays, back by 6pm" }),
      fetchBundles: async () => { bundleCalls++; return { bundles: [{ id: "pkg-1", size: "5", price: 10 }], total: 1 } },
    })
    const r = await pickNetwork("1", deps)
    expect(r.Message).toBe("MTN delays, back by 6pm\n" + networkMenuText())
    expect(store.get("S1")?.step).toBe("SELECT_NETWORK")
    expect(bundleCalls).toBe(0)
  })

  it("matches the DB spelling 'AT - iShare' to the USSD network 'AT-iShare'", async () => {
    const { deps } = makeDeps({ stockNotices: async () => ({ "AT - iShare": "AT iShare back tomorrow" }) })
    const r = await pickNetwork("3", deps)
    expect(r.Message).toBe("AT iShare back tomorrow\n" + networkMenuText())
  })

  it("lists bundles as before for a network with no notice", async () => {
    const { deps, store } = makeDeps({ stockNotices: async () => ({ MTN: "x" }) })
    await pickNetwork("2", deps)
    expect(store.get("S1")?.step).toBe("SELECT_BUNDLE")
  })

  it("fails open: a notices error behaves exactly like today", async () => {
    const { deps, store } = makeDeps({ stockNotices: async () => { throw new Error("db down") } })
    await pickNetwork("1", deps)
    expect(store.get("S1")?.step).toBe("SELECT_BUNDLE")
  })

  it("a full 100-character reason plus the menu fits one USSD screen", async () => {
    const reason = "x".repeat(100)
    const { deps } = makeDeps({ stockNotices: async () => ({ MTN: reason }) })
    const r = await pickNetwork("1", deps)
    expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
  })
})
