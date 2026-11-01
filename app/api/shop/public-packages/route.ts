import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { loadPublicShopPackages } from "@/lib/shop-commerce/public-packages"

// Force dynamic rendering
export const dynamic = "force-dynamic"
export const revalidate = 0

function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables")
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

// GET: Get packages for a public shop storefront (by slug)
// This handles both regular shops (shop_packages) and sub-agents (sub_agent_catalog)
export async function GET(request: NextRequest) {
  // Apply rate limiting: 60 requests per minute per IP
  const rateLimit = await applyRateLimit(
    request,
    'public-packages',
    RATE_LIMITS.PUBLIC_PACKAGES.maxRequests,
    RATE_LIMITS.PUBLIC_PACKAGES.windowMs
  )

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.PUBLIC_PACKAGES.message },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': RATE_LIMITS.PUBLIC_PACKAGES.maxRequests.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': new Date(rateLimit.resetAt).toISOString(),
        }
      }
    )
  }

  try {
    const supabase = getSupabaseClient()

    const url = new URL(request.url)
    const shopSlug = url.searchParams.get("slug")

    if (!shopSlug) {
      return NextResponse.json({ error: "Shop slug required" }, { status: 400 })
    }

    // Get shop by handle — match either the clean subdomain or the legacy shop_slug
    // (on a subdomain storefront this value is the subdomain; see middleware rewrite).
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, shop_name, user_id, parent_shop_id, is_active")
      .or(shopHandleOrFilter(shopSlug))
      .eq("is_active", true)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Same loader the server-rendered storefront uses (app/shop/[slug]/page.tsx),
    // so the API and the server HTML always show the same prices.
    const loaded = await loadPublicShopPackages(supabase, shop)
    if (!loaded.ok) {
      return NextResponse.json({ error: loaded.error }, { status: 500 })
    }
    const packages = loaded.packages

    // Get global ordering status
    // Use select("*") to match the working debug endpoint and avoid any column selection issues
    const { data: settingsResult, error: settingsError } = await supabase
      .from("app_settings")
      .select("*")
      .is("key", null)

    console.log("[PUBLIC-API] Global Settings query result:", {
      data: settingsResult,
      error: settingsError
    })

    // Handle both array and single object returns just in case
    const settings = Array.isArray(settingsResult) ? settingsResult[0] : settingsResult
    const orderingEnabled = settings?.ordering_enabled ?? true
    console.log("[PUBLIC-API] Resolved ordering_enabled:", orderingEnabled)

    // Fetch shop settings for individual announcement
    const { data: shopSettings } = await supabase
      .from("shop_settings")
      .select("announcement_enabled, announcement_title, announcement_message")
      .eq("shop_id", shop.id)
      .single()

    // 1. Check Global Override First (from settings we already fetched)
    let activeAnnouncement = null
    
    if (settings && settings.storefront_announcement_enabled) {
      activeAnnouncement = {
        title: settings.storefront_announcement_title || "",
        message: settings.storefront_announcement_message || "",
        is_global: true
      }
    } 
    // 2. Fall back to Shop's specific announcement
    else if (shopSettings?.announcement_enabled && shopSettings?.announcement_title && shopSettings?.announcement_message) {
      activeAnnouncement = {
        title: shopSettings.announcement_title,
        message: shopSettings.announcement_message,
        is_global: false
      }
    }

    return NextResponse.json({
      packages,
      is_sub_agent: !!shop.parent_shop_id,
      ordering_enabled: orderingEnabled,
      announcement: activeAnnouncement,
      terms_content: settings?.terms_content ?? "",
      terms_content_data: settings?.terms_content_data ?? "",
      terms_content_airtime: settings?.terms_content_airtime ?? "",
      terms_content_results_checker: settings?.terms_content_results_checker ?? "",
      terms_content_bulk_sms: settings?.terms_content_bulk_sms ?? "",
      terms_last_updated: settings?.terms_last_updated ?? null,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      }
    })

  } catch (error) {
    console.error("Error in public-packages API:", error)
    return NextResponse.json(
      { error: "Failed to load packages. Please try again." },
      { status: 500 }
    )
  }
}
