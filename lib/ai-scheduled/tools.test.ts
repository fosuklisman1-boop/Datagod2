import { describe, it, expect } from "vitest"
import { withoutPrepareTools } from "./tools"
import { aiTools } from "@/lib/ai-tools"

describe("withoutPrepareTools", () => {
  it("removes every prepare_* tool and keeps the rest", () => {
    const all = aiTools("dashboard")
    expect(all.some((t) => t.name.startsWith("prepare_"))).toBe(true)
    const kept = withoutPrepareTools(all)
    expect(kept.some((t) => t.name.startsWith("prepare_"))).toBe(false)
    expect(kept.length).toBe(all.filter((t) => !t.name.startsWith("prepare_")).length)
    expect(kept.length).toBeGreaterThan(0)
  })
})
