import { describe, it, expect } from "vitest"
import { docPageMetadata } from "./page-meta"
import { DOC_PAGES, STATIC_DOC_PAGES } from "./pages"

const slugs: (string | undefined)[] = [undefined, ...DOC_PAGES.map((p) => p.slug), ...STATIC_DOC_PAGES.map((p) => p.slug)]

describe("docPageMetadata", () => {
  it("sets canonical and openGraph url from the path", () => {
    expect(docPageMetadata("data").alternates?.canonical).toBe("https://www.datagod.store/developers/data")
    expect(docPageMetadata().alternates?.canonical).toBe("https://www.datagod.store/developers")
    expect((docPageMetadata("data").openGraph as { url?: string }).url).toBe("https://www.datagod.store/developers/data")
    expect(docPageMetadata("data").twitter).toMatchObject({ card: "summary_large_image" })
  })

  it("has unique titles ending in | DATAGOD, at most 70 characters", () => {
    const titles = slugs.map((s) => String(docPageMetadata(s).title))
    expect(new Set(titles).size).toBe(titles.length)
    for (const t of titles) {
      expect(t.endsWith("| DATAGOD")).toBe(true)
      expect(t.length).toBeLessThanOrEqual(70)
    }
    expect(String(docPageMetadata("data").title)).toBe("Data and wallet | Developer API | DATAGOD")
  })

  it("has a description for every page", () => {
    for (const s of slugs) expect(String(docPageMetadata(s).description).length).toBeGreaterThan(30)
  })

  it("throws on an unknown slug", () => {
    expect(() => docPageMetadata("nope")).toThrow()
  })
})
