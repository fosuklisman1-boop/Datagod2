export type Audience = "public" | "customer" | "dealer" | "shop_owner" | "admin"

export interface SiteArticle {
  id: string
  title: string
  audiences: Audience[]
  keywords: string[]
  summary: string
  body: string
  /** Shop surfaces this article must not appear on (it is about the platform's own channels, or a web-only flow). */
  hiddenOn?: ShopSurface[]
}

export interface SitePage {
  path: string
  title: string
  audiences: Audience[]
  purpose: string
  tasks: string[]
  /** Shop surfaces this page must not appear on (it is about the platform's own channels, or a web-only flow). */
  hiddenOn?: ShopSurface[]
}

/** The shop-owned chat surfaces: the web storefront chat and the WhatsApp shop bot. */
export type ShopSurface = "storefront" | "whatsapp_shop"

/** Hidden on both shop surfaces: about Datagod's own channels or platform-level services. */
export const HIDDEN_ON_SHOPS: ShopSurface[] = ["storefront", "whatsapp_shop"]

/** Options shared by the guide renderer and the article search. */
export interface SiteViewOptions {
  /** Set on a shop-owned surface: items whose hiddenOn lists it are left out. Unset (home, dashboard, admin): nothing is hidden. */
  surface?: ShopSurface
}

export interface RenderOptions extends SiteViewOptions {
  /** Mention get_knowledge_base in the articles line (default true). False: the surface has no such tool, so the line is dropped. */
  toolHint?: boolean
}
