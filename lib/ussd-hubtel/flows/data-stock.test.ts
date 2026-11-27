// Main-code data flow: a network the admin marked out of stock shows the admin's reason in place of
// "No X packages available." — and never hides bundles that are actually on sale.
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
// Out of stock = every package disabled, so the catalog returns nothing.
const noBundles = async () => ({ bundles: [], total: 0 })

describe("main data flow: out-of-stock reason", () => {
  it("shows the reason above the network menu when the network has no bundles", async () => {
    const { deps, store } = makeDeps({ stockNotices: async () => ({ MTN: "MTN delays, back by 6pm" }), fetchBundles: noBundles })
    const r = await pickNetwork("1", deps)
    expect(r.Message).toBe("MTN delays, back by 6pm\n" + networkMenuText())
    expect(store.get("S1")?.step).toBe("SELECT_NETWORK")
  })

  it("still lists bundles the admin re-enabled while the network is flagged (partial restock)", async () => {
    const { deps, store } = makeDeps({ stockNotices: async () => ({ MTN: "MTN delays" }) })
    const r = await pickNetwork("1", deps)
    expect(r.Message).toContain("Select Package")
    expect(store.get("S1")?.step).toBe("SELECT_BUNDLE")
  })

  it("matches the DB spelling 'AT - iShare' to the USSD network 'AT-iShare'", async () => {
    const { deps } = makeDeps({ stockNotices: async () => ({ "AT - iShare": "AT iShare back tomorrow" }), fetchBundles: noBundles })
    const r = await pickNetwork("3", deps)
    expect(r.Message).toBe("AT iShare back tomorrow\n" + networkMenuText())
  })

  it("fails open: a notices error shows today's message", async () => {
    const { deps } = makeDeps({ stockNotices: async () => { throw new Error("db down") }, fetchBundles: noBundles })
    const r = await pickNetwork("1", deps)
    expect(r.Message).toBe("No MTN packages available.\n" + networkMenuText())
  })

  it("a full 100-character reason plus the menu fits one USSD screen and keeps '0. Back'", async () => {
    const { deps } = makeDeps({ stockNotices: async () => ({ MTN: "x".repeat(100) }), fetchBundles: noBundles })
    const r = await pickNetwork("1", deps)
    expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(r.Message.endsWith("0. Back")).toBe(true)
  })
})
