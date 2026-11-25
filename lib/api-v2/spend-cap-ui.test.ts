import { createElement } from "react"
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import { SpendCapView } from "@/components/developer/SpendCapControl"

const html = (p: Partial<Parameters<typeof SpendCapView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SpendCapView, {
      label: "Standard live key dg2_live_ab",
      spentToday: 12.5,
      cap: 50,
      adminLimitApplies: false,
      active: true,
      value: "50",
      busy: false,
      error: null,
      onChange: () => {},
      onSave: () => {},
      ...p,
    }),
  )

describe("SpendCapView", () => {
  it("field labelled 'Daily spending limit (GHS)' and 'Spent today: GHS x'", () => {
    const out = html()
    expect(out).toContain("Daily spending limit (GHS)")
    expect(out).toContain("Spent today: GHS 12.50")
    expect(out).toContain('value="50"')
  })
  it("'A Datagod daily limit also applies' only when an admin limit exists, and never a value for it", () => {
    expect(html()).not.toContain("A Datagod daily limit also applies")
    const out = html({ adminLimitApplies: true })
    expect(out).toContain("A Datagod daily limit also applies")
  })
  it("'Not active yet' while caps are switched off", () => {
    expect(html({ active: false })).toContain("Not active yet")
    expect(html({ active: true })).not.toContain("Not active yet")
  })
  it("empty means no limit; an error is shown as text; busy disables Save", () => {
    expect(html({ value: "", cap: null })).toMatch(/No limit/)
    expect(html({ error: "The limit must be an amount" })).toContain("The limit must be an amount")
    expect(html({ busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Save/)
  })
})
