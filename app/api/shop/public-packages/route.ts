import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { CustomPriceReadError, MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"
import { marginsValid, subAgentCosts } from "@/lib/shop-commerce/pricing"

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

    // Fetch user role to check for dealer pricing
    const { data: userData } = await supabase
      .from("users")
      .select("role")
      .eq("id", shop.user_id)
      .single()
    const isDealer = userData?.role === 'dealer' || userData?.role === 'admin'

    let packages: any[] = []

    // Check if this is a sub-agent (has parent_shop_id)
    if (shop.parent_shop_id) {
      // Sub-agent prices: the parent's LIVE cost (subAgentCosts: parent role price + the parent's active
      // wholesale margin) + the sub-agent's margin, exactly what app/api/shop/orders/create charges. Stored
      // parent_price snapshots are not trusted. Packages the parent no longer offers are hidden.
      const priceRows = async (rows: any[], subMarginOf: (item: any) => number) => {
        const { costs } = await subAgentCosts(
          shop.parent_shop_id,
          rows.map((item: any) => String(item.package_id)),
          supabase as Parameters<typeof subAgentCosts>[2]
        )
        return rows
          .filter((item: any) => item.package?.is_available)
          .map((item: any) => ({ item, offer: costs.get(String(item.package_id)), subAgentMargin: subMarginOf(item) }))
          .filter(({ offer, subAgentMargin }) => !!offer && marginsValid(subAgentMargin))
          .map(({ item, offer, subAgentMargin }) => {
            const parentPrice = offer!.cost
            return {
              id: item.id,
              package_id: item.package.id,
              profit_margin: subAgentMargin,
              parent_price: parentPrice,
              is_available: item.is_active,
              packages: {
                id: item.package.id,
                network: item.package.network,
                size: item.package.size,
                price: parentPrice,
                description: item.package.description
              },
              selling_price: Math.round((parentPrice + subAgentMargin) * 100) / 100
            }
          })
      }

      // Sub-agent: get packages from sub_agent_shop_packages table (their own inventory)
      // Fall back to sub_agent_catalog for backwards compatibility
      const { data: shopPkgs, error: shopPkgsError } = await supabase
        .from("sub_agent_shop_packages")
        .select(`
          id,
          package_id,
          sub_agent_profit_margin,
          is_active,
          package:packages (
            id,
            network,
            size,
            price,
            dealer_price,
            description,
            is_available
          )
        `)
        .eq("shop_id", shop.id)
        .eq("is_active", true)

      if (shopPkgsError && shopPkgsError.code !== 'PGRST116') {
        // If not "relation does not exist", it's a real error
        console.error("Error fetching sub-agent shop packages:", shopPkgsError)
        return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
      }

      try {
        // If sub_agent_shop_packages table exists and has data, use it
        if (!shopPkgsError && shopPkgs && shopPkgs.length > 0) {
          packages = await priceRows(shopPkgs, (item: any) => Number(item.sub_agent_profit_margin || 0))
        } else {
          // Fall back to sub_agent_catalog for backwards compatibility
          const { data: catalogItems, error: catalogError } = await supabase
            .from("sub_agent_catalog")
            .select(`
              id,
              package_id,
              sub_agent_profit_margin,
              is_active,
              package:packages (
                id,
                network,
                size,
                price,
                dealer_price,
                description,
                is_available
              )
            `)
            .eq("shop_id", shop.id)
            .eq("is_active", true)

          if (catalogError) {
            console.error("Error fetching sub-agent catalog:", catalogError)
            return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
          }

          // Own-shop rows: the cost uses the PARENT's active row (an own-shop wholesale_margin is never used),
          // and the sub-agent margin as the order route reads it.
          packages = await priceRows(catalogItems || [], (item: any) => Number(item.sub_agent_profit_margin || 0))
        }
      } catch (e) {
        if (!(e instanceof CustomPriceReadError)) throw e
        console.error("[PUBLIC-API] Could not read the parent's catalog or pricing")
        return NextResponse.json({ error: MSG_PRICES_UNAVAILABLE }, { status: 503 })
      }

    } else {
      // Regular shop owner: get packages from shop_packages
      const { data: shopPackages, error: pkgError } = await supabase
        .from("shop_packages")
        .select(`
          id,
          package_id,
          profit_margin,
          is_available,
          custom_name,
          packages (
            id,
            network,
            size,
            price,
            dealer_price,
            description,
            is_available
          )
        `)
        .eq("shop_id", shop.id)
        .eq("is_available", true)

      if (pkgError) {
        console.error("Error fetching shop packages:", pkgError)
        return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
      }

      // Filter out disabled admin packages
      packages = (shopPackages || [])
        .filter((item: any) => item.packages?.is_available !== false)
        .map((item: any) => {
          const basePrice = (isDealer && item.packages.dealer_price > 0)
            ? item.packages.dealer_price
            : item.packages.price;

          return {
            ...item,
            packages: {
              ...item.packages,
              price: basePrice
            },
            selling_price: basePrice + item.profit_margin
          }
        })
    }

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
