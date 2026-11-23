import type { Metadata } from "next"
import { DOC_PAGES, STATIC_DOC_PAGES, docPath } from "./pages"

const SITE = "https://www.datagod.store"

const HUB_TITLE = "Developer API | DATAGOD"
const HUB_DESCRIPTION =
  "Build on Datagod. Buy data bundles, airtime, utility bills and results checker vouchers, register AFA customers and send SMS from your own software, with cURL, Node.js, PHP and Python examples and a ready-made Postman collection."

/** Metadata for the hub (no slug) or any docs page. Throws on an unknown slug so a typo fails the build. */
export function docPageMetadata(slug?: string): Metadata {
  let title = HUB_TITLE
  let description = HUB_DESCRIPTION
  if (slug) {
    const page = [...DOC_PAGES, ...STATIC_DOC_PAGES].find((p) => p.slug === slug)
    if (!page) throw new Error(`Unknown developer docs page: ${slug}`)
    title = `${page.title} | Developer API | DATAGOD`
    description = page.description
  }
  const url = `${SITE}${docPath(slug)}`
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: "website",
      siteName: "DATAGOD",
      locale: "en_GH",
      images: ["/og-image.png"],
    },
    twitter: { card: "summary_large_image", title, description, images: ["/og-image.png"] },
  }
}
