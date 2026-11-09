// Lives here, not beside the component: vitest only collects tests under lib/ and app/.
import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// Records every Switch's props so a test can drive onCheckedChange without a DOM.
const switches = vi.hoisted(() => [] as any[])
vi.mock("@/components/ui/switch", () => ({
  Switch: (props: any) => { switches.push(props); return createElement("button", { "aria-label": props["aria-label"] }) },
}))

import { HubtelLineSettings } from "@/components/admin/hubtel-line-settings"
import { hubtelSaveBody } from "@/lib/ussd-hubtel/line"
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
  it("the Main tab renders a Wallet payment switch and the Shop tab does not", () => {
    expect(render("main")).toContain("Wallet payment")
    expect(render("shop", { ...CONFIG, mode: "shop" })).not.toContain("Wallet payment")
  })
  it("the Wallet payment switch saves through hubtelSaveBody with line main", () => {
    const saves: [object, string][] = []
    switches.length = 0
    renderToStaticMarkup(createElement(HubtelLineSettings, {
      line: "main", config: { ...CONFIG, walletPayment: false }, envOk: true, busy: null, onSave: (b, l) => { saves.push([b, l]) },
    }))
    const sw = switches.find(s => s["aria-label"] === "Toggle Wallet payment")
    expect(sw).toBeDefined()
    sw.onCheckedChange(true)
    expect(saves).toEqual([[hubtelSaveBody("main", { walletPayment: true }), "main:walletPayment"]])
    expect(saves[0][0]).toEqual({ walletPayment: true, line: "main" })
  })
  it("the shop code keeps its Mode selector and shows no registration URLs", () => {
    const html = render("shop", { ...CONFIG, mode: "shop" })
    expect(html).toContain("Hubtel USSD mode")
    expect(html).toContain("Toggle Hubtel USSD")
    expect(html).not.toContain("line=main")
  })
})
