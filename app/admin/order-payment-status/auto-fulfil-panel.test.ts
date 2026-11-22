// Static-render tests for the auto-fulfil settings form (house pattern: send-components.test.ts).
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AutoFulfilSettingsForm, enabledChangedMessage, saveBody, turnOnCopy, turnOnLines } from "@/components/admin/order-queue/auto-fulfil-panel"
import { settingsToDraft } from "@/lib/auto-fulfil/panel-format"
import { DEFAULT_AUTO_FULFIL_SETTINGS } from "@/lib/auto-fulfil/settings"
import { FAILURE_REASON_LABELS } from "@/lib/order-queue/failure-reason"

const noop = () => {}
const render = (error: string | null = null) =>
  renderToStaticMarkup(
    createElement(AutoFulfilSettingsForm, {
      draft: settingsToDraft(DEFAULT_AUTO_FULFIL_SETTINGS),
      onChange: noop,
      saving: false,
      error,
      onSave: noop,
    }),
  )

describe("AutoFulfilSettingsForm", () => {
  it("shows a row per retry bucket with its failure label", () => {
    const html = render()
    for (const b of ["rate_limited", "out_of_balance", "supplier_unavailable", "not_enabled", "no_bundle", "wrong_number", "rejected"] as const) {
      expect(html).toContain(`Wait minutes: ${FAILURE_REASON_LABELS[b]}`)
    }
  })

  it("disables, not hides, wait and tries for a bucket with retry off", () => {
    const html = render()
    const wait = (label: string) => html.match(new RegExp(`<input[^>]*aria-label="Wait minutes: ${label}"[^>]*>`))?.[0] ?? ""
    expect(wait(FAILURE_REASON_LABELS.no_bundle)).toContain('disabled=""')
    expect(wait(FAILURE_REASON_LABELS.rate_limited)).not.toContain('disabled=""')
  })

  it("shows the allowed ranges and an inline error", () => {
    const html = render("perRun must be a whole number from 1 to 100")
    expect(html).toContain("10 to 120 minutes")
    expect(html).toContain("1 to 30 days")
    expect(html).toContain("1 to 100.")
    expect(html).toContain("Wait 1 to 10080 minutes. Tries 1 to 20.")
    expect(html).toContain("perRun must be a whole number from 1 to 100")
  })

  it("lays out general and retry columns side by side on desktop", () => {
    expect(render()).toContain("lg:grid-cols-2")
  })
})

describe("turn-on confirmation copy", () => {
  it("names the minimum age", () => {
    expect(turnOnCopy(15)).toBe("Orders older than 15 minutes will be sent to suppliers automatically. Turn on?")
  })

  it("M6: with readable settings there is only the main line", () => {
    expect(turnOnLines(15, true)).toEqual([turnOnCopy(15)])
  })

  it("M6: with unreadable saved settings (valid === false) the dialog adds the defaults warning", () => {
    expect(turnOnLines(15, false)).toEqual([
      turnOnCopy(15),
      "Your saved settings could not be read, so the default settings will be saved.",
    ])
  })
})

describe("stale-switch message (I5)", () => {
  it("says who changed it and what to do, by the state now stored", () => {
    expect(enabledChangedMessage(true)).toBe("Auto-fulfil was switched on by someone else — check and save again.")
    expect(enabledChangedMessage(false)).toBe("Auto-fulfil was switched off by someone else — check and save again.")
  })

  it("falls back to a neutral wording when the stored state is not known", () => {
    expect(enabledChangedMessage(null)).toBe("Auto-fulfil was switched on or off by someone else — check and save again.")
  })
})

describe("save request body (I5)", () => {
  it("the switch sends toggle: true; Save settings does not", () => {
    const s = structuredClone(DEFAULT_AUTO_FULFIL_SETTINGS)
    expect(JSON.parse(saveBody(s, true)).toggle).toBe(true)
    expect("toggle" in JSON.parse(saveBody(s, false))).toBe(false)
    expect(JSON.parse(saveBody(s, false)).enabled).toBe(s.enabled)
  })
})
