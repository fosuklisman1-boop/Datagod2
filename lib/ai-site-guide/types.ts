export type Audience = "public" | "customer" | "dealer" | "shop_owner" | "admin"

export interface SiteArticle {
  id: string
  title: string
  audiences: Audience[]
  keywords: string[]
  summary: string
  body: string
}

export interface SitePage {
  path: string
  title: string
  audiences: Audience[]
  purpose: string
  tasks: string[]
}
