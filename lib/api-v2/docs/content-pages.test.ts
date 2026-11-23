import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { docPageMetadata } from "./page-meta"
import { buildErrorGuide } from "./error-guide"
import { CHANGELOG } from "./changelog"
import { STARTER_KITS } from "./starter-kits"
import { copyApiMarkdown } from "./copy-for-ai"
import GoLivePage, { metadata as goLiveMeta } from "@/app/developers/go-live/page"
import StarterKitsPage, { metadata as kitsMeta } from "@/app/developers/starter-kits/page"
import ErrorsPage, { metadata as errorsMeta } from "@/app/developers/errors/page"
import ChangelogPage, { metadata as changelogMeta } from "@/app/developers/changelog/page"
import { ErrorGuideList } from "@/components/developer/docs/ErrorGuideList"

async function html(Page: () => unknown): Promise<string> {
  return renderToStaticMarkup((await Page()) as React.ReactElement)
}

describe("static docs pages", () => {
  it("export metadata with the canonical from docPageMetadata", () => {
    const cases = [
      ["go-live", goLiveMeta],
      ["starter-kits", kitsMeta],
      ["errors", errorsMeta],
      ["changelog", changelogMeta],
    ] as const
    for (const [slug, meta] of cases) {
      expect(meta.alternates?.canonical).toBe(docPageMetadata(slug).alternates?.canonical)
      expect(meta.alternates?.canonical).toBe(`https://www.datagod.store/developers/${slug}`)
    }
  })

  it("go-live renders every step", async () => {
    const out = await html(GoLivePage)
    expect(out).toContain('id="request-live-key"')
    expect(out).toContain("Message admin on WhatsApp")
  })

  it("errors page has an id per guide anchor and REFERENCE_REUSED", async () => {
    const out = await html(ErrorsPage)
    for (const e of buildErrorGuide()) expect(out).toContain(`id="${e.anchor}"`)
    expect(out).toContain("REFERENCE_REUSED")
  })

  it("changelog lists every title and labels the scheduled entry", async () => {
    const out = await html(ChangelogPage)
    for (const c of CHANGELOG) expect(out).toContain(c.title.replace(/&/g, "&amp;"))
    expect(out).toContain("Scheduled")
  })

  it("starter-kits shows filenames, download links and escaped source", async () => {
    const out = await html(StarterKitsPage)
    for (const k of STARTER_KITS) {
      expect(out).toContain(k.filename)
      expect(out).toContain(`href="/developers/starter-kits/${k.id}"`)
    }
    expect(out).toContain("&lt;?php")
    expect(out).not.toContain("<?php")
  })
})

describe("copyApiMarkdown", () => {
  it("resolves true when fetch and write succeed", async () => {
    let written = ""
    const ok = await copyApiMarkdown(
      async () => ({ ok: true, text: async () => "# api" }),
      async (t) => ((written = t), true),
    )
    expect(ok).toBe(true)
    expect(written).toBe("# api")
  })
  it("resolves false when fetch rejects, is not OK, or the write fails", async () => {
    expect(await copyApiMarkdown(async () => { throw new Error("x") }, async () => true)).toBe(false)
    expect(await copyApiMarkdown(async () => ({ ok: false, text: async () => "" }), async () => true)).toBe(false)
    expect(await copyApiMarkdown(async () => ({ ok: true, text: async () => "# api" }), async () => false)).toBe(false)
  })
})

describe("ErrorGuideList", () => {
  it("renders an article per entry with status chip and fix", () => {
    const entries = buildErrorGuide().slice(0, 3)
    const out = renderToStaticMarkup(createElement(ErrorGuideList, { entries }))
    expect(out.match(/<article/g)?.length).toBe(3)
    for (const e of entries) {
      expect(out).toContain(String(e.status))
      expect(out).toContain(e.fix.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").slice(0, 20))
    }
  })
  it("renders the empty state", () => {
    expect(renderToStaticMarkup(createElement(ErrorGuideList, { entries: [] }))).toContain("No matching errors")
  })
})
