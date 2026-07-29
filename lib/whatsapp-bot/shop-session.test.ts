import { getSession, setSession, deleteSession } from "@/lib/whatsapp-bot/shop-session"
import { WaShopSession } from "@/lib/whatsapp-bot/shop-types"

// Upstash env vars are not set in the test environment, so these exercise the
// in-memory fallback cache path — that's the intended contract under test
// (round-trip, miss, and delete behave the same regardless of backend).
describe("whatsapp-bot shop-session", () => {
  it("returns null for a phone that was never set", async () => {
    const result = await getSession("233240000001")
    expect(result).toBeNull()
  })

  it("round-trips a session through set then get", async () => {
    const phone = "233240000002"
    const session: WaShopSession = {
      step: "SELECT_BUNDLE",
      shopCodeId: "shop-abc",
      shopId: "shop-1",
      shopName: "Test Shop",
      network: "MTN",
      bundleTotal: 15,
    }

    await setSession(phone, session)
    const result = await getSession(phone)

    expect(result).toEqual(session)
  })

  it("returns null after a session is deleted", async () => {
    const phone = "233240000003"
    const session: WaShopSession = { step: "ENTER_CODE" }

    await setSession(phone, session)
    expect(await getSession(phone)).toEqual(session)

    await deleteSession(phone)
    expect(await getSession(phone)).toBeNull()
  })

  it("keeps sessions for different phones independent", async () => {
    const phoneA = "233240000004"
    const phoneB = "233240000005"
    const sessionA: WaShopSession = { step: "CONFIRM", recipientPhone: "0241111111" }
    const sessionB: WaShopSession = { step: "RC_SELECT_BOARD", rcBoard: "WASSCE" }

    await setSession(phoneA, sessionA)
    await setSession(phoneB, sessionB)

    expect(await getSession(phoneA)).toEqual(sessionA)
    expect(await getSession(phoneB)).toEqual(sessionB)
  })
})
