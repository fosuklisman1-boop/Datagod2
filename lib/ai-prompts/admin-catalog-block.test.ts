import { describe, it, expect } from "vitest"
import { adminCatalogBlock, REMOVED_ADMIN_TOOLS } from "./admin-catalog-block"
import { adminToolNames } from "@/lib/ai-tools"
import { buildAdminPrompt } from "./admin"

describe("admin catalog block (switch ON)", () => {
  it("says the older acting tools are gone and every change goes through find_admin_actions then prepare_admin_change", () => {
    const b = adminCatalogBlock()
    expect(b).toContain("no longer available")
    expect(b).toContain("find_admin_actions")
    expect(b).toContain("prepare_admin_change")
    for (const name of REMOVED_ADMIN_TOOLS) expect(b).toContain(name)
  })

  it("the listed names are exactly the acting admin tools the registry drops when the switch is on", () => {
    const off = new Set(adminToolNames(false))
    const on = new Set(adminToolNames(true))
    const dropped = [...off].filter((n) => !on.has(n)).sort()
    expect([...REMOVED_ADMIN_TOOLS].sort()).toEqual(dropped)
  })

  it("the switch-OFF prompt does not mention the override", () => {
    const base = { ussdDialCode: "*1#", firstName: "A", lastName: "B", today: "2026-11-24", cardNonce: "n" }
    expect(buildAdminPrompt({ ...base, adminCatalog: false } as any).stable).not.toContain("no longer available")
    expect(buildAdminPrompt({ ...base, adminCatalog: true } as any).stable).toContain("no longer available")
  })
})
