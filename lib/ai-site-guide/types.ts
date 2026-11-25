export type Audience = "public" | "customer" | "dealer" | "shop_owner" | "admin"

export interface SiteArticle {
  id: string
  title: string
  audiences: Audience[]
  keywords: string[]
  summary: string
  body: string
  /** About Datagod's own channels or platform-level services; hidden on shop surfaces (storefront, shop bot). */
  platformOnly?: true
}

export interface SitePage {
  path: string
  title: string
  audiences: Audience[]
  purpose: string
  tasks: string[]
  /** About Datagod's own channels or platform-level services; hidden on shop surfaces (storefront, shop bot). */
  platformOnly?: true
}

/** Options shared by the guide renderer and the article search. */
export interface SiteViewOptions {
  /** Shop-owned surface (web storefront chat, WhatsApp shop bot): hide platformOnly items. */
  shopSurface?: boolean
}

export interface RenderOptions extends SiteViewOptions {
  /** Mention get_knowledge_base in the articles line (default true). False: the surface has no such tool, so the line is dropped. */
  toolHint?: boolean
}
