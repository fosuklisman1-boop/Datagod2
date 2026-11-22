// Static-render tests for the auto-fulfil settings form (house pattern: send-components.test.ts).
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AutoFulfilSettingsForm, turnOnCopy } from "@/components/admin/order-queue/auto-fulfil-panel"
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
})
