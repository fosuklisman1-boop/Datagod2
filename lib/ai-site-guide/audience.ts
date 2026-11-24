import type { Audience } from "./types"

export interface AudienceContext {
  context: "home" | "storefront" | "dashboard" | "admin" | "whatsapp" | "whatsapp_shop"
  role?: string | null
  isShopOwner?: boolean
  signedIn?: boolean
}

/** Which parts of the site guide a given chat surface and user may see. */
export function audiencesFor(ctx: AudienceContext): Audience[] {
  if (ctx.role === "admin" || ctx.context === "admin") {
    return ["public", "customer", "dealer", "shop_owner", "admin"]
  }
  if (ctx.context === "home" || ctx.context === "storefront" || ctx.context === "whatsapp_shop") {
    return ["public"]
  }
  if (!ctx.signedIn) return ["public"]
  const out: Audience[] = ["public", "customer"]
  if (ctx.role === "dealer") out.push("dealer")
  if (ctx.isShopOwner) out.push("shop_owner")
  return out
}
