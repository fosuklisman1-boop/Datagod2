import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { SERVICES, serviceForEndpoint, blocksMethod, PAUSE_BLOCKS_READS } from "./services"
import { DOC_PAGES } from "./docs/pages"

const EXEMPT_PREFIXES = ["/api/v2/account/", "/api/v2/wallet/"]

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...routeFiles(p))
    else if (name === "route.ts") out.push(p)
  }
  return out
}

describe("services", () => {
  it("every endpoint literal found in app/api/v2/**/route.ts maps to a service or is in the exempt list (account, wallet); a new unmapped path fails", () => {
    const files = routeFiles(join(process.cwd(), "app", "api", "v2"))
    const endpoints: string[] = []
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/endpoint:\s*"([^"]+)"/g)) endpoints.push(m[1])
    }
    expect(endpoints.length).toBeGreaterThanOrEqual(25)
    const unmapped = endpoints.filter(
      (e) => serviceForEndpoint(e) === null && !EXEMPT_PREFIXES.some((p) => e.startsWith(p)),
    )
    expect(unmapped).toEqual([])
    for (const e of endpoints.filter((e) => EXEMPT_PREFIXES.some((p) => e.startsWith(p)))) {
      expect(serviceForEndpoint(e)).toBeNull()
    }
  })

  it("/api/v2/orders/[reference] and /packages -> data; /utilities/pay -> bills; /resultschecker/types -> results; unknown -> null", () => {
    expect(serviceForEndpoint("/api/v2/orders/[reference]")).toBe("data")
    expect(serviceForEndpoint("/api/v2/packages")).toBe("data")
    expect(serviceForEndpoint("/api/v2/utilities/pay")).toBe("bills")
    expect(serviceForEndpoint("/api/v2/resultschecker/types")).toBe("results")
    expect(serviceForEndpoint("/api/v2/airtime/purchase")).toBe("airtime")
    expect(serviceForEndpoint("/api/v2/bundles/catalog")).toBe("bundles")
    expect(serviceForEndpoint("/api/v2/afa/register")).toBe("afa")
    expect(serviceForEndpoint("/api/v2/sms/send")).toBe("sms")
    expect(serviceForEndpoint("/api/v2/data/bulk")).toBe("data")
    expect(serviceForEndpoint("/api/v2/whatever")).toBeNull()
    expect(serviceForEndpoint("/api/v2/packagesx")).toBeNull()
    expect(serviceForEndpoint("")).toBeNull()
  })

  it("SERVICES ids equal DocSlug values of lib/api-v2/docs/pages.ts", () => {
    expect(SERVICES.map((s) => s.id)).toEqual(DOC_PAGES.map((p) => p.slug))
    expect(SERVICES.map((s) => s.title)).toEqual(DOC_PAGES.map((p) => p.title))
  })

  it("reads stay up while PAUSE_BLOCKS_READS is false", () => {
    expect(PAUSE_BLOCKS_READS).toBe(false)
    expect(blocksMethod("GET")).toBe(false)
    expect(blocksMethod("head")).toBe(false)
    expect(blocksMethod("POST")).toBe(true)
    expect(blocksMethod("DELETE")).toBe(true)
  })
})
