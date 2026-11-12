import { describe, it, expect } from "vitest"
import { back, current, openRoot, push, setTab } from "./drawer-stack"

describe("user drawer navigation stack", () => {
  it("opening starts a fresh stack on the Profile tab", () => {
    expect(openRoot("u1")).toEqual([{ userId: "u1", tab: "profile" }])
    expect(current(openRoot("u1"))).toEqual({ userId: "u1", tab: "profile" })
    expect(current([])).toBeNull()
  })

  it("keeps each entry's tab, so Back returns to the tab you came from", () => {
    let s = setTab(openRoot("owner"), "shop")
    s = push(s, "sub-agent")
    expect(current(s)).toEqual({ userId: "sub-agent", tab: "profile" })
    s = setTab(s, "orders")
    s = back(s)
    expect(current(s)).toEqual({ userId: "owner", tab: "shop" })
  })

  it("opening the user already on top does nothing; Back on the root does nothing", () => {
    const s = openRoot("u1")
    expect(push(s, "u1")).toBe(s)
    expect(back(s)).toBe(s)
  })

  it("does not mutate", () => {
    const s = openRoot("u1")
    setTab(s, "wallet")
    push(s, "u2")
    expect(s).toEqual([{ userId: "u1", tab: "profile" }])
  })
})
