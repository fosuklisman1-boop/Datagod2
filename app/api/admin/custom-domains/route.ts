import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { isReservedDomainHost, type DomainService } from "@/lib/custom-domains"
import { TOGGLEABLE_PAGES } from "@/lib/custom-domain-pages"
import { setCustomDomainCache, clearCustomDomainCache } from "@/lib/custom-domain-lookup"

const VALID_SERVICES: DomainService[] = ["data_bundles", "airtime", "results_checker", "bulk_sms"]
const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()

function normalizeDomainInput(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "")
}

/** Validates a `services` request field: must be a non-empty array of known
 * service values. Returns the deduplicated array, or an error message. */
function parseServices(raw: unknown): { services: DomainService[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `'services' must be a non-empty array of: ${VALID_SERVICES.join(", ")}` }
  }
  const invalid = raw.find(s => !VALID_SERVICES.includes(s as DomainService))
  if (invalid !== undefined) {
    return { error: `'services' must be one of: ${VALID_SERVICES.join(", ")} (got "${invalid}")` }
  }
  return { services: Array.from(new Set(raw as DomainService[])) }
}

/** Validates an optional linked_shop_id: undefined/null is fine (no shop
 * linked); a non-null value must reference an existing row in user_shops.
 * Also returns the shop's subdomain — callers need it to keep the
 * write-through cache's `linked_shop_subdomain` field correct, since a
 * cache hit never re-queries Supabase to pick it up later. */
async function validateLinkedShopId(raw: unknown): Promise<{ linkedShopId: string | null; linkedShopSubdomain: string | null } | { error: string }> {
  if (raw === undefined || raw === null || raw === "") return { linkedShopId: null, linkedShopSubdomain: null }
  if (typeof raw !== "string") return { error: "'linked_shop_id' must be a string or null" }
  const { data, error } = await supabase.from("user_shops").select("id, subdomain, is_active, is_blocked").eq("id", raw).maybeSingle()
  if (error) {
    console.error("[CUSTOM-DOMAINS] Failed to validate linked_shop_id:", error)
    return { error: "Failed to validate linked_shop_id" }
  }
  if (!data) return { error: `No shop found with id "${raw}"` }
  if (!data.is_active || data.is_blocked) {
    return { error: `Shop "${raw}" is not active and cannot be linked to a domain` }
  }
  return { linkedShopId: raw, linkedShopSubdomain: data.subdomain }
}

const VALID_PAGE_KEYS = new Set(TOGGLEABLE_PAGES.map(p => p.key))

/** Validates a `hidden_pages` request field: must be an array of known
 * TOGGLEABLE_PAGES keys (empty array is valid — "nothing hidden"). Returns
 * the deduplicated array, or an error message. */
function parseHiddenPages(raw: unknown): { hiddenPages: string[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "'hidden_pages' must be an array of page keys" }
  }
  const invalid = raw.find(k => !VALID_PAGE_KEYS.has(k as string))
  if (invalid !== undefined) {
    return { error: `'hidden_pages' contains an unknown key: "${invalid}"` }
  }
  return { hiddenPages: Array.from(new Set(raw as string[])) }
}

/** Validates an optional `wildcard_shops_enabled` request field: undefined
 * defaults to false (unchanged), anything else must be a boolean. */
function parseWildcardShopsEnabled(raw: unknown): { wildcardShopsEnabled: boolean } | { error: string } {
  if (raw === undefined) return { wildcardShopsEnabled: false }
  if (typeof raw !== "boolean") return { error: "'wildcard_shops_enabled' must be a boolean" }
  return { wildcardShopsEnabled: raw }
}

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data, error } = await supabase
    .from("custom_domains")
    .select("id, domain, services, site_name, logo_url, primary_color, is_active, linked_shop_id, hidden_pages, wildcard_shops_enabled, created_at, updated_at")
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[CUSTOM-DOMAINS] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch custom domains" }, { status: 500 })
  }
  return NextResponse.json({ domains: data })
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const domain = normalizeDomainInput(String(body.domain || ""))
    const siteName = String(body.site_name || "").trim()
    const logoUrl = body.logo_url ? String(body.logo_url) : null
    const primaryColor = body.primary_color ? String(body.primary_color) : null

    if (!domain || !domain.includes(".")) {
      return NextResponse.json({ error: "A valid domain is required" }, { status: 400 })
    }
    const servicesResult = parseServices(body.services)
    if ("error" in servicesResult) {
      return NextResponse.json({ error: servicesResult.error }, { status: 400 })
    }
    const { services } = servicesResult
    if (!siteName) {
      return NextResponse.json({ error: "'site_name' is required" }, { status: 400 })
    }
    let hiddenPages: string[] | undefined
    if (body.hidden_pages !== undefined) {
      const hiddenPagesResult = parseHiddenPages(body.hidden_pages)
      if ("error" in hiddenPagesResult) {
        return NextResponse.json({ error: hiddenPagesResult.error }, { status: 400 })
      }
      hiddenPages = hiddenPagesResult.hiddenPages
    }
    if (isReservedDomainHost(domain, ROOT_DOMAIN)) {
      return NextResponse.json(
        { error: `"${domain}" collides with the main app's own domain routing and can't be used as a custom domain` },
        { status: 400 }
      )
    }
    const wildcardResult = parseWildcardShopsEnabled(body.wildcard_shops_enabled)
    if ("error" in wildcardResult) {
      return NextResponse.json({ error: wildcardResult.error }, { status: 400 })
    }
    const linkedShopResult = await validateLinkedShopId(body.linked_shop_id)
    if ("error" in linkedShopResult) {
      return NextResponse.json({ error: linkedShopResult.error }, { status: 400 })
    }
    let { linkedShopId, linkedShopSubdomain } = linkedShopResult
    const wildcardShopsEnabled = wildcardResult.wildcardShopsEnabled

    // Mutual exclusivity (migration 0104): a domain can never both be
    // linked to one shop and wildcard-enabled. Wildcard wins if a single
    // request somehow sets both — the admin UI's own checkbox/dropdown
    // never submits both at once in practice (see app/admin/custom-domains/
    // page.tsx), so this only resolves a malformed/direct-API request
    // deterministically rather than leaving an inconsistent row.
    if (wildcardShopsEnabled) {
      linkedShopId = null
      linkedShopSubdomain = null
    }

    const row = {
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
      linked_shop_id: linkedShopId,
      wildcard_shops_enabled: wildcardShopsEnabled,
      ...(hiddenPages !== undefined ? { hidden_pages: hiddenPages } : {}),
    }
    const { data, error } = await supabase.from("custom_domains").insert(row).select().single()

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json({ error: `"${domain}" is already configured` }, { status: 409 })
      }
      throw error
    }

    await setCustomDomainCache({
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
      linked_shop_subdomain: linkedShopSubdomain,
      wildcard_shops_enabled: wildcardShopsEnabled,
      hidden_pages: data.hidden_pages,
    })

    return NextResponse.json({ domain: data }, { status: 201 })
  } catch (error) {
    console.error("[CUSTOM-DOMAINS] POST error:", error)
    return NextResponse.json({ error: "Failed to create custom domain" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const id = String(body.id || "")
    if (!id) return NextResponse.json({ error: "'id' is required" }, { status: 400 })

    // Fetch the CURRENT linked_shop_id/domain before mutating, so if this
    // domain is (or was) shop-linked, the derived subdomain cache entry
    // (<shop's own subdomain>.<domain>, used by lib/custom-domain-lookup.ts's
    // resolveCustomDomain fallback) can be invalidated below regardless of
    // which fields this PATCH actually changes — unlinking, deactivating, or
    // re-linking to a different shop would otherwise leave that derived
    // entry serving stale routing for up to CACHE_TTL_SECONDS.
    const { data: beforeRow } = await supabase.from("custom_domains").select("domain, linked_shop_id").eq("id", id).maybeSingle()

    const updates: Record<string, unknown> = {}
    if (body.services !== undefined) {
      const servicesResult = parseServices(body.services)
      if ("error" in servicesResult) {
        return NextResponse.json({ error: servicesResult.error }, { status: 400 })
      }
      updates.services = servicesResult.services
    }
    if (body.site_name !== undefined) {
      const siteName = String(body.site_name).trim()
      if (!siteName) return NextResponse.json({ error: "'site_name' cannot be empty" }, { status: 400 })
      updates.site_name = siteName
    }
    if (body.logo_url !== undefined) updates.logo_url = body.logo_url ? String(body.logo_url) : null
    if (body.primary_color !== undefined) updates.primary_color = body.primary_color ? String(body.primary_color) : null
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== "boolean") return NextResponse.json({ error: "'is_active' must be a boolean" }, { status: 400 })
      updates.is_active = body.is_active
    }
    if (body.wildcard_shops_enabled !== undefined) {
      const wildcardResult = parseWildcardShopsEnabled(body.wildcard_shops_enabled)
      if ("error" in wildcardResult) {
        return NextResponse.json({ error: wildcardResult.error }, { status: 400 })
      }
      updates.wildcard_shops_enabled = wildcardResult.wildcardShopsEnabled
    }
    if (body.linked_shop_id !== undefined) {
      const linkedShopResult = await validateLinkedShopId(body.linked_shop_id)
      if ("error" in linkedShopResult) {
        return NextResponse.json({ error: linkedShopResult.error }, { status: 400 })
      }
      updates.linked_shop_id = linkedShopResult.linkedShopId
    }
    // Mutual exclusivity (migration 0104), same precedence as POST above:
    // whichever of the two fields THIS request sets to an "on" value wins
    // and clears the other in the SAME update, so two separate PATCH calls
    // (one per field, as the admin UI's mutually-exclusive checkbox/dropdown
    // naturally sends) always converge correctly even though the client
    // never has to send the cleared field itself.
    if (updates.wildcard_shops_enabled === true) {
      updates.linked_shop_id = null
    } else if (updates.linked_shop_id) {
      updates.wildcard_shops_enabled = false
    }
    if (body.hidden_pages !== undefined) {
      const hiddenPagesResult = parseHiddenPages(body.hidden_pages)
      if ("error" in hiddenPagesResult) {
        return NextResponse.json({ error: hiddenPagesResult.error }, { status: 400 })
      }
      updates.hidden_pages = hiddenPagesResult.hiddenPages
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 })
    }
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase.from("custom_domains").update(updates).eq("id", id).select().single()
    if (error) throw error
    if (!data) return NextResponse.json({ error: "Domain not found" }, { status: 404 })

    if (beforeRow?.linked_shop_id) {
      const { data: oldShopRow } = await supabase.from("user_shops").select("subdomain").eq("id", beforeRow.linked_shop_id).maybeSingle()
      if (oldShopRow?.subdomain) {
        await clearCustomDomainCache(`${oldShopRow.subdomain}.${beforeRow.domain}`)
      }
    }

    if (data.is_active) {
      let linkedShopSubdomain: string | null = null
      let shopLookupFailed = false
      if (data.linked_shop_id) {
        const { data: shopRow, error: shopLookupError } = await supabase.from("user_shops").select("subdomain").eq("id", data.linked_shop_id).maybeSingle()
        if (shopLookupError) {
          console.error("[CUSTOM-DOMAINS] PATCH: failed to resolve linked shop's subdomain for cache write:", shopLookupError)
          shopLookupFailed = true
        } else {
          linkedShopSubdomain = shopRow?.subdomain ?? null
        }
      }
      if (shopLookupFailed) {
        // Don't write a config we know may have the wrong linked_shop_subdomain —
        // clear the cache instead so the next request re-resolves it fresh from
        // Supabase, rather than caching a guessed value for up to 5 minutes.
        await clearCustomDomainCache(data.domain)
      } else {
        await setCustomDomainCache({
          domain: data.domain, services: data.services, site_name: data.site_name,
          logo_url: data.logo_url, primary_color: data.primary_color, is_active: data.is_active,
          linked_shop_subdomain: linkedShopSubdomain,
          wildcard_shops_enabled: data.wildcard_shops_enabled,
          hidden_pages: data.hidden_pages,
        })
      }
    } else {
      await clearCustomDomainCache(data.domain)
    }

    return NextResponse.json({ domain: data })
  } catch (error) {
    console.error("[CUSTOM-DOMAINS] PATCH error:", error)
    return NextResponse.json({ error: "Failed to update custom domain" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const id = request.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "'id' query param is required" }, { status: 400 })

  const { data, error } = await supabase.from("custom_domains").delete().eq("id", id).select().maybeSingle()
  if (error) {
    console.error("[CUSTOM-DOMAINS] DELETE error:", error)
    return NextResponse.json({ error: "Failed to delete custom domain" }, { status: 500 })
  }
  if (data) {
    await clearCustomDomainCache(data.domain)
    if (data.linked_shop_id) {
      const { data: oldShopRow } = await supabase.from("user_shops").select("subdomain").eq("id", data.linked_shop_id).maybeSingle()
      if (oldShopRow?.subdomain) {
        await clearCustomDomainCache(`${oldShopRow.subdomain}.${data.domain}`)
      }
    }
  }

  return NextResponse.json({ success: true })
}
