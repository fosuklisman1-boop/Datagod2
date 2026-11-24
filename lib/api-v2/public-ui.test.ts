import { createElement } from "react"
import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { AnnouncementBannerView } from "@/components/developer/AnnouncementBanner"
import { StatusBoardView } from "@/components/developer/StatusBoard"
import type { PublicStatus } from "./status-public"

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const ann = (o = {}) => ({ id: "a1", title: "Maintenance", body: "Short window tonight", severity: "info" as const, endsAt: "2026-11-25T00:00:00.000Z", ...o })

describe("AnnouncementBannerView", () => {
  it("renders nothing when empty", () => {
    expect(html(createElement(AnnouncementBannerView, { items: [], dismissed: [], onDismiss: () => {} }))).toBe("")
  })
  it("title and body render as text: a script tag is shown literally and there are no links", () => {
    const out = html(createElement(AnnouncementBannerView, { items: [ann({ title: "<script>x</script>", body: "see <a href='http://evil'>here</a>" })], dismissed: [], onDismiss: () => {} }))
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
    expect(out).not.toContain("<a ")
  })
  it("each severity has an icon and a text label; critical is not dismissible; dismissed ones are hidden", () => {
    const out = html(
      createElement(AnnouncementBannerView, {
        items: [ann({ id: "i" }), ann({ id: "w", severity: "warning" }), ann({ id: "c", severity: "critical" }), ann({ id: "gone" })],
        dismissed: ["gone"],
        onDismiss: () => {},
      }),
    )
    for (const label of ["Notice", "Warning", "Critical"]) expect(out).toContain(label)
    expect(out.match(/<svg/g)!.length).toBeGreaterThanOrEqual(3)
    expect(out.match(/aria-label="Dismiss/g)!.length).toBe(2)
    expect(out).toMatch(/dark:/)
    expect((out.match(/Short window tonight/g) ?? []).length).toBe(3)
  })
})

const status = (services: PublicStatus["services"]): PublicStatus => ({ generatedAt: "2026-11-24T06:00:00.000Z", services })

describe("StatusBoardView", () => {
  it("renders paused with message, degraded, no_data and operational, each with an icon and a label", () => {
    const out = html(
      createElement(StatusBoardView, {
        status: status([
          { id: "data", title: "Data and wallet", state: "operational", message: null, successRate24h: 99.5 },
          { id: "airtime", title: "Airtime", state: "paused", message: "Back at 3pm", successRate24h: 98 },
          { id: "bills", title: "Utility bills", state: "degraded", message: null, successRate24h: 80 },
          { id: "sms", title: "SMS", state: "no_data", message: null, successRate24h: null },
        ]),
        loading: false,
        error: null,
      }),
    )
    for (const t of ["Operational", "Paused", "Degraded", "Not enough traffic yet", "Back at 3pm", "99.5%"]) expect(out).toContain(t)
    expect(out.match(/<svg/g)!.length).toBeGreaterThanOrEqual(4)
    expect(out).toMatch(/dark:/)
  })
  it("shows no numbers other than the rate (no counts)", () => {
    const out = html(createElement(StatusBoardView, { status: status([{ id: "sms", title: "SMS", state: "no_data", message: null, successRate24h: null }]), loading: false, error: null }))
    const text = out.replace(/<[^>]+>/g, " ")
    expect(text).not.toMatch(/\b\d+\s+requests?\b/i)
  })
  it("error shows a calm message, not a crash", () => {
    expect(html(createElement(StatusBoardView, { status: null, loading: false, error: "x" }))).toMatch(/could not load the status/i)
  })
})

describe("wiring", () => {
  it("status page is a static page with a client-fetched board (no server fetch at build)", () => {
    const src = readFileSync("app/developers/status/page.tsx", "utf8")
    expect(src).not.toMatch(/async function|await |fetch\(/)
    expect(src).toContain("<StatusBoard")
  })
  it("banner and board: AbortController, sessionStorage only inside try/catch", () => {
    const banner = readFileSync("components/developer/AnnouncementBanner.tsx", "utf8")
    expect(banner).toContain("AbortController")
    const uses = banner.split("sessionStorage").length - 1
    const guarded = (banner.match(/try\s*\{[^}]*sessionStorage/g) ?? []).length
    expect(uses).toBeGreaterThan(0)
    expect(guarded).toBe(uses)
    expect(readFileSync("components/developer/StatusBoard.tsx", "utf8")).toContain("AbortController")
  })
  it("docs layout mounts the banner; the developer dashboard change is exactly one import and one element", () => {
    expect(readFileSync("app/developers/layout.tsx", "utf8")).toContain("<AnnouncementBanner")
    const dash = readFileSync("app/dashboard/developer/page.tsx", "utf8")
    expect(dash.match(/^import .*AnnouncementBanner.*$/gm)!.length).toBe(1)
    expect(dash.match(/<AnnouncementBanner\b/g)!.length).toBe(1)
    expect(dash.match(/AnnouncementBanner/g)!.length).toBe(3)
  })
})
