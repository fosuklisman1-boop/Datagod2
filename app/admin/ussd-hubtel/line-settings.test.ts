// Lives here, not beside the component: vitest only collects tests under lib/ and app/.
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { HubtelLineSettings } from "@/components/admin/hubtel-line-settings"
import type { HubtelUssdConfig } from "@/lib/ussd-hubtel/config"

const CONFIG: HubtelUssdConfig = {
  enabled: false, mode: "main", brandName: "Clingshub", welcome: "Welcome to Clingshub", welcomeCustom: false,
  visibility: { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true },
}
const render = (line: "shop" | "main", config: HubtelUssdConfig = CONFIG) =>
  renderToStaticMarkup(createElement(HubtelLineSettings, { line, config, envOk: true, busy: null, onSave: () => {} }))

describe("HubtelLineSettings", () => {
  it("the main code has no Mode selector and shows the URLs with only a secret placeholder", () => {
    const html = render("main")
    expect(html).not.toContain("Hubtel USSD mode")
    expect(html).toContain("Toggle Hubtel main code")
    expect(html).toContain("&amp;line=main")
    expect(html).toContain("&lt;HUBTEL_WEBHOOK_SECRET&gt;")
  })
  it("the shop code keeps its Mode selector and shows no registration URLs", () => {
    const html = render("shop", { ...CONFIG, mode: "shop" })
    expect(html).toContain("Hubtel USSD mode")
    expect(html).toContain("Toggle Hubtel USSD")
    expect(html).not.toContain("line=main")
  })
})
