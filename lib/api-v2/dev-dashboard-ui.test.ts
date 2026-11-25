// Lives here, not beside the components: vitest only collects tests under lib/ and app/.
// Static render only (no effects run): each tab renders its first frame without crashing, and the bars draw both parts.
import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import { DayBars } from "@/components/developer/dashboard/DayBars"
import { OverviewTab } from "@/components/developer/dashboard/OverviewTab"
import { UsageTab } from "@/components/developer/dashboard/UsageTab"
import { LogsTab } from "@/components/developer/dashboard/LogsTab"
import { OrdersTab } from "@/components/developer/dashboard/OrdersTab"

describe("developer dashboard tabs (first frame)", () => {
  it("DayBars draws an ok and a failed bar per day with a readable title", () => {
    const html = renderToStaticMarkup(createElement(DayBars, { points: [{ day: "2026-11-24", ok: 3, failed: 1 }, { day: "2026-11-25", ok: 0, failed: 0 }] }))
    expect((html.match(/<rect/g) ?? []).length).toBe(4)
    expect(html).toContain("2026-11-24: 3 ok, 1 failed")
  })
  it("each tab renders without crashing and says what it is", () => {
    expect(renderToStaticMarkup(createElement(OverviewTab, { onOpenTab: () => undefined }))).toContain("Low-balance alert")
    expect(renderToStaticMarkup(createElement(UsageTab))).toContain("Why requests failed")
    expect(renderToStaticMarkup(createElement(LogsTab))).toContain("Request logs")
    const orders = renderToStaticMarkup(createElement(OrdersTab))
    expect(orders).toContain("Order finder")
    expect(orders).toContain("Download CSV")
  })
})
