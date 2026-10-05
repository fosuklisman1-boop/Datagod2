import { describe, it, expect } from "vitest"
import { sessionStore } from "./session"
import type { HubtelSession } from "./types"

const s: HubtelSession = { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" }

describe("hubtel session store (no redis configured)", () => {
  it("round-trips and deletes", async () => {
    expect(await sessionStore.get("a1")).toBeNull()
    await sessionStore.set("a1", s)
    expect(await sessionStore.get("a1")).toEqual(s)
    await sessionStore.del("a1")
    expect(await sessionStore.get("a1")).toBeNull()
  })
})
