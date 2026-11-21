import { describe, it, expect } from "vitest"
import { historyKey, trimHistory, safeLoad, safeSave } from "./history"

describe("history", () => {
  it("history_key_per_widget_user_shop", () => {
    expect(historyKey("home", {})).toBe("datagod-ai-chat:home:guest")
    expect(historyKey("home", { userId: "u1" })).toBe("datagod-ai-chat:home:u1")
    expect(historyKey("storefront", { shopId: "s1" })).toBe("datagod-ai-chat:storefront:s1:guest")
    expect(historyKey("storefront", { shopId: "s1", userId: "u1" })).toBe("datagod-ai-chat:storefront:s1:u1")
    expect(historyKey("admin", { userId: "a" })).not.toBe(historyKey("dashboard", { userId: "a" }))
  })
  it("history_trim_30", () => {
    const a = Array.from({ length: 45 }, (_, i) => i)
    expect(trimHistory(a, 30)).toEqual(a.slice(15))
    expect(trimHistory([1, 2], 30)).toEqual([1, 2])
  })
  it("history_storage_throw_safe", () => {
    const boom = {
      getItem() { throw new Error("x") },
      setItem() { throw new Error("x") },
      removeItem() { throw new Error("x") },
    }
    expect(safeLoad(boom, "k")).toBeNull()
    expect(() => safeSave(boom, "k", [1])).not.toThrow()
    expect(() => safeSave(null, "k", [1])).not.toThrow()
    expect(safeLoad(null, "k")).toBeNull()
    const mem = new Map<string, string>()
    const s = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    }
    safeSave(s, "k", { a: 1 })
    expect(safeLoad(s, "k")).toEqual({ a: 1 })
    s.setItem("bad", "{nope")
    expect(safeLoad(s, "bad")).toBeNull()
  })
})
