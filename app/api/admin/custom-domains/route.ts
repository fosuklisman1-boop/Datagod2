import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { isReservedDomainHost, type DomainService } from "@/lib/custom-domains"
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

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data, error } = await supabase
    .from("custom_domains")
    .select("id, domain, services, site_name, logo_url, primary_color, is_active, created_at, updated_at")
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
    if (isReservedDomainHost(domain, ROOT_DOMAIN)) {
      return NextResponse.json(
        { error: `"${domain}" collides with the main app's own domain routing and can't be used as a custom domain` },
        { status: 400 }
      )
    }

    const row = { domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true }
    const { data, error } = await supabase.from("custom_domains").insert(row).select().single()

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json({ error: `"${domain}" is already configured` }, { status: 409 })
      }
      throw error
    }

    await setCustomDomainCache({
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
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

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 })
    }
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase.from("custom_domains").update(updates).eq("id", id).select().single()
    if (error) throw error
    if (!data) return NextResponse.json({ error: "Domain not found" }, { status: 404 })

    if (data.is_active) {
      await setCustomDomainCache({
        domain: data.domain, services: data.services, site_name: data.site_name,
        logo_url: data.logo_url, primary_color: data.primary_color, is_active: data.is_active,
      })
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
  if (data) await clearCustomDomainCache(data.domain)

  return NextResponse.json({ success: true })
}
