// The WhatsApp cashback switches card on /admin/whatsapp: the page renders it, it reads the switches from the
// validated admin route, and it shows the three WhatsApp switches with their stored state and live status.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { WhatsAppCashbackSwitches } from "./cashback-switches"
import {
  parseWaCashbackState, waCashbackStatus, WA_CASHBACK_API, WA_CASHBACK_SWITCHES, type WaCashbackState,
} from "@/lib/whatsapp-bot/cashback-visibility-admin"

const OFF = { networkPlans: false, payBills: false, cashbackAirtime: false }

describe("view helpers", () => {
  it("the three WhatsApp switches, in order, against the admin route", () => {
    expect(WA_CASHBACK_SWITCHES.map(s => [s.key, s.label])).toEqual([
      ["networkPlans", "Network Plans"], ["payBills", "Pay Bills"], ["cashbackAirtime", "Cashback airtime"],
    ])
    expect(WA_CASHBACK_API).toBe("/api/admin/whatsapp/cashback-visibility")
  })

  it("parses only a well-formed answer", () => {
    const ok = { switches: { ...OFF, payBills: true }, live: OFF }
    expect(parseWaCashbackState(ok)).toEqual(ok)
    for (const bad of [null, {}, { switches: OFF }, { switches: { ...OFF, payBills: "true" }, live: OFF }, { switches: OFF, live: { networkPlans: true } }]) {
      expect(parseWaCashbackState(bad)).toBeNull()
    }
  })

  it("status: off / waiting (switch on, cashback Bots gate off) / live", () => {
    const s: WaCashbackState = {
      switches: { networkPlans: true, payBills: true, cashbackAirtime: false },
      live: { networkPlans: true, payBills: false, cashbackAirtime: false },
    }
    expect(waCashbackStatus(s, "networkPlans")).toBe("live")
    expect(waCashbackStatus(s, "payBills")).toBe("waiting")
    expect(waCashbackStatus(s, "cashbackAirtime")).toBe("off")
  })
})

describe("the card", () => {
  it("renders the three switches with their stored state and status", () => {
    const html = renderToStaticMarkup(createElement(WhatsAppCashbackSwitches, {
      initial: {
        switches: { networkPlans: true, payBills: true, cashbackAirtime: false },
        live: { networkPlans: true, payBills: false, cashbackAirtime: false },
      },
    }))
    for (const label of ["Network Plans", "Pay Bills", "Cashback airtime"]) expect(html).toContain(label)
    expect(html).toContain("WhatsApp")
    expect(html).toMatch(/aria-label="Network Plans \(WhatsApp\)"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="Network Plans \(WhatsApp\)"/)
    expect(html).toMatch(/aria-label="Cashback airtime \(WhatsApp\)"[^>]*aria-checked="false"|aria-checked="false"[^>]*aria-label="Cashback airtime \(WhatsApp\)"/)
    expect(html).toContain("Live")
    expect(html).toContain("Waiting for the cashback Bots switch")
  })

  it("before the first read: a loading state, no switch shown as off", () => {
    const html = renderToStaticMarkup(createElement(WhatsAppCashbackSwitches, {}))
    expect(html).not.toContain('aria-checked="false"')
  })

  it("the WhatsApp admin page renders the card, and the card reads the admin route", () => {
    const page = readFileSync(path.join(__dirname, "page.tsx"), "utf8")
    expect(page).toContain('from "./cashback-switches"')
    expect(page).toContain("<WhatsAppCashbackSwitches")
    const card = readFileSync(path.join(__dirname, "cashback-switches.tsx"), "utf8")
    expect(card).toContain("WA_CASHBACK_API")
    expect(card).toContain("parseWaCashbackState")
  })
})
