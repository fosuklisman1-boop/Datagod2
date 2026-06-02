// A shop's public handle is either its clean `subdomain` or its legacy `shop_slug`.
// Storefronts may be reached by either (the subdomain rewrite passes the subdomain
// as the [slug] param), so lookups must match both columns.
//
// IMPORTANT: handles come from the URL / request body and are attacker-controllable.
// We build a PostgREST `.or()` filter by string interpolation, so we MUST sanitize
// first — otherwise a value like "x,is_active.eq.false" could inject extra OR
// conditions. Valid handles are lowercase alphanumerics + hyphens, so stripping
// everything else fully neutralizes injection without affecting legitimate lookups.

export function sanitizeShopHandle(handle: string): string {
  return String(handle).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 255)
}

// Returns a PostgREST `.or()` filter string that matches a shop by either column,
// e.g. `supabase.from("user_shops").or(shopHandleOrFilter(slug))`.
export function shopHandleOrFilter(handle: string): string {
  const safe = sanitizeShopHandle(handle)
  return `subdomain.eq.${safe},shop_slug.eq.${safe}`
}
