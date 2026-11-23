import { v2DocsRegistry, type V2DocSection } from "./registry"
import { DOC_PAGES, docPath, sectionHref, sectionsForPage } from "./pages"

/** Height in px of the sticky site header (px, not rem: globals.css scales the root font size on small screens). */
export const DOCS_HEADER_PX = 64

export interface NavItem {
  label: string
  href: string
  sections?: { id: string; label: string; href: string }[]
}
export interface NavGroup {
  label: string
  items: NavItem[]
}

function sectionLinks(registry: V2DocSection[], slug: Parameters<typeof sectionsForPage>[1]) {
  return sectionsForPage(registry, slug).map((s) => ({ id: s.id, label: s.label, href: sectionHref(s.id) }))
}

/** The shared docs navigation: Start, Products (one item per product page with its sections), Reference. */
export function buildDocsNav(registry: V2DocSection[] = v2DocsRegistry): NavGroup[] {
  return [
    {
      label: "Start",
      items: [
        { label: "Overview", href: docPath(), sections: sectionLinks(registry, null) },
        { label: "Go live", href: docPath("go-live") },
        { label: "Starter kits", href: docPath("starter-kits") },
      ],
    },
    {
      label: "Products",
      items: DOC_PAGES.map((p) => ({ label: p.title, href: docPath(p.slug), sections: sectionLinks(registry, p.slug) })),
    },
    {
      label: "Reference",
      items: [
        { label: "Errors", href: docPath("errors") },
        { label: "Changelog", href: docPath("changelog") },
        { label: "OpenAPI", href: "/developers/openapi.json" },
        { label: "Postman", href: "/developers/postman/collection" },
      ],
    },
  ]
}

/** The nav href that matches a pathname: exact page, ignoring hash, query and a trailing slash. */
export function activeNavHref(pathname: string): string {
  const path = pathname.split(/[#?]/)[0]
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}
