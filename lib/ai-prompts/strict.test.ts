import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildHomePrompt, buildStorefrontPrompt, buildDashboardPrompt, buildAdminPrompt } from "./index"

// Stricter checks on top of golden.test.ts (whose literals are frozen): exact equality where volatile is empty,
// and line multiplicity + order where the prompt is split. The golden literals are read from the frozen file.
function loadGolden(): Record<string, string> {
  const src = readFileSync(join(__dirname, "golden.test.ts"), "utf8").replace(/\r\n/g, "\n")
  const out: Record<string, string> = {}
  const re = /^  (\w+): `([\s\S]*?)`,\n(?=  \w+: `|\}\n)/gm
  for (const m of src.matchAll(re)) out[m[1]] = m[2].replace(/\\\$\{/g, "${").replace(/\\`/g, "`").replace(/\\\\/g, "\\")
  return out
}
const GOLDEN = loadGolden()

// Golden inputs (see golden.test.ts harness).
const DIAL = "*999*1#"
const CHANNEL = "\nUPDATES CHANNEL: our WhatsApp channel for updates, new bundles & deals is https://chat.example/chan. Share it (as a plain URL) when someone asks about updates/promos or wants to stay in the loop."
const shop = { shopName: "Kofi Data Hub", ussdDialCode: DIAL, shopUssdCode: "4321" as string | null }
const dash = { ussdDialCode: DIAL, channelNote: CHANNEL, firstName: "Ama", lastName: "Mensah", role: "dealer", phone: "0240000000", balance: "GHS 12.50", today: "2026-01-02", cardNonce: "NONCE" }
const adm = { ussdDialCode: DIAL, firstName: "Ama", lastName: "Mensah", today: "2026-01-02", cardNonce: "NONCE" }

const nonEmpty = (s: string) => s.split("\n").filter((l) => l.trim())
// Every golden line is kept verbatim (no rewordings); new lines may be added around them.
const expectedLines = (golden: string) => nonEmpty(golden)

function assertSplitFaithful(golden: string, p: { stable: string; volatile: string }) {
  const exp = expectedLines(golden)
  const expSet = new Set(exp)
  const stableLines = nonEmpty(p.stable)
  const volLines = nonEmpty(p.volatile)
  // Multiplicity: every golden line appears exactly as often as before (extra new lines are allowed).
  const count = (arr: string[], l: string) => arr.filter((x) => x === l).length
  for (const l of expSet) {
    expect({ l, n: count([...stableLines, ...volLines], l) }).toEqual({ l, n: count(exp, l) })
  }
  // Order: lines that stayed in stable keep their relative order; same for the volatile ones.
  const stableSet = new Set(stableLines)
  expect(stableLines.filter((l) => expSet.has(l))).toEqual(exp.filter((l) => stableSet.has(l) && !volLines.includes(l)))
  expect(volLines.filter((l) => expSet.has(l))).toEqual(exp.filter((l) => volLines.includes(l)))
}

describe("strict golden checks", () => {
  it("golden literals loaded", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(["admin", "dashboard_dealer", "home", "storefront_all", "storefront_data_only"])
  })

  it("home stable equals golden exactly", () => {
    const p = buildHomePrompt({ ussdDialCode: DIAL, guestPurchaseUrl: "/guest-buy", channelNote: CHANNEL, knowledge: "" })
    expect(p.volatile).toBe("")
    expect(p.stable).toBe(GOLDEN.home)
  })

  it("storefront stable equals golden exactly (all services, data only)", () => {
    const all = buildStorefrontPrompt({ ...shop, storefrontServices: null, knowledge: "" })
    expect(all.volatile).toBe("")
    expect(all.stable).toBe(GOLDEN.storefront_all)
    // FINDING: golden.test.ts's "storefront_data_only" case never exercised a restricted storefront (the harness
    // request carried no Host header, so no domain config was resolved): its literal is byte-identical to
    // storefront_all. The frozen literal therefore pins the unrestricted prompt twice.
    expect(GOLDEN.storefront_data_only).toBe(GOLDEN.storefront_all)
    expect(buildStorefrontPrompt({ ...shop, storefrontServices: null, knowledge: "" }).stable).toBe(GOLDEN.storefront_data_only)
  })

  it("restricted (data only) storefront: golden lines kept, scope rule added", () => {
    const data = buildStorefrontPrompt({ ...shop, storefrontServices: ["data_bundles"], knowledge: "" })
    expect(data.volatile).toBe("")
    expect(data.stable).toContain("online shop for data bundles")
    expect(data.stable).toContain("SCOPE: This storefront ONLY sells data bundles")
    expect(data.stable).toContain("prepare_checkout")
    expect(data.stable).not.toContain("AIRTIME TOP-UP")
    expect(data.stable).not.toContain("RESULTS CHECKER VOUCHERS")
  })

  it("dashboard keeps golden line multiplicity and order", () => {
    assertSplitFaithful(GOLDEN.dashboard_dealer, buildDashboardPrompt({ ...dash, knowledge: "" }))
  })

  it("admin keeps golden line multiplicity and order", () => {
    assertSplitFaithful(GOLDEN.admin, buildAdminPrompt({ ...adm, knowledge: "" }))
  })

  it("the balance rule points at CURRENT REQUEST, which really holds the balance", () => {
    const p = buildDashboardPrompt({ ...dash, knowledge: "" })
    // Original rule line kept verbatim, with an added pointer line right after it.
    expect(p.stable).toContain("never rely on the balance shown in ACCOUNT CONTEXT, it can be stale.\n(The balance snapshot for this request is listed under CURRENT REQUEST below.)")
    expect(p.volatile).toContain("CURRENT REQUEST")
    expect(p.volatile).toContain("Wallet balance (snapshot): GHS 12.50")
  })
})

describe("extra cases: stable identical across users/dates", () => {
  it("storefront with no USSD code", () => {
    const a = buildStorefrontPrompt({ ...shop, shopUssdCode: null, storefrontServices: null, knowledge: "" })
    const b = buildStorefrontPrompt({ ...shop, shopUssdCode: null, storefrontServices: null, knowledge: "" })
    expect(a.stable).toBe(b.stable)
    expect(a.volatile).toBe("")
    expect(a.stable).not.toContain("ORDER BY USSD")
  })

  it("storefront selling airtime only", () => {
    const a = buildStorefrontPrompt({ ...shop, storefrontServices: ["airtime"], knowledge: "" })
    const b = buildStorefrontPrompt({ ...shop, storefrontServices: ["airtime"], knowledge: "" })
    expect(a.stable).toBe(b.stable)
    expect(a.volatile).toBe("")
    expect(a.stable).not.toContain("prepare_checkout")
    expect(a.stable).toContain("AIRTIME TOP-UP")
    expect(a.stable).toContain("online shop for airtime")
  })

  it("non-dealer dashboard role (user): same stable as dealer, different volatile", () => {
    const dealer = buildDashboardPrompt({ ...dash, knowledge: "" })
    const user = buildDashboardPrompt({ ...dash, role: "user", firstName: "Kojo", lastName: "Boateng", phone: "0240000002", balance: "GHS 1.00", today: "2026-03-04", cardNonce: "N2", knowledge: "" })
    expect(user.stable).toBe(dealer.stable)
    expect(user.volatile).not.toBe(dealer.volatile)
    expect(user.volatile).toContain("**user**")
    expect(user.stable).not.toContain("**user**")
  })
})
