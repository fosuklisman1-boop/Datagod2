import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import { sendSMS, notifyPriceManipulation } from "@/lib/sms-service"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { verifyShopSession } from "@/lib/shop-token"
import { verifyTurnstileToken, getRequestIp, isTurnstileEnabled } from "@/lib/turnstile"
import { secureTimestampedReference } from "@/lib/secure-random"
import { checkEmailQuality } from "@/lib/email-heuristics"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await applyRateLimit(
      request,
      "shop_order_create",
      RATE_LIMITS.SHOP_ORDER_CREATE.maxRequests,
      RATE_LIMITS.SHOP_ORDER_CREATE.windowMs
    )
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: RATE_LIMITS.SHOP_ORDER_CREATE.message },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": RATE_LIMITS.SHOP_ORDER_CREATE.maxRequests.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": new Date(rateLimit.resetAt).toISOString(),
          },
        }
      )
    }

    // Check Global Ordering Status
    // Use select("*") to match the working debug endpoint and avoid any column selection issues
    const { data: settingsResult, error: settingsError } = await supabase
      .from("app_settings")
      .select("*")

    if (settingsError) {
      console.error("[SHOP-ORDER] Error checking global settings:", settingsError)
    }

    // Handle both array and single object returns just in case
    const settings = Array.isArray(settingsResult) ? settingsResult[0] : settingsResult

    console.log("[SHOP-ORDER] Global settings check:", {
      found: !!settings,
      enabled: settings?.ordering_enabled
    })

    if (settings && settings.ordering_enabled === false) {
      console.warn("[SHOP-ORDER] ⛔ Order blocked: Global ordering is disabled")
      return NextResponse.json(
        { error: "Order placement is currently disabled by the administrator. Please try again later." },
        { status: 503 }
      )
    }

    const body = await request.json()
    let {
      shop_id,
      customer_email,
      customer_phone,
      customer_name,
      shop_package_id,
      package_id,
      network,
      volume_gb,
      base_price,
      profit_amount,
      total_price,
      shop_slug,
      turnstileToken,
      website: honeypot,
    } = body

    // SECURITY: never trust the client's shop_id. The slug is the public identifier
    // (visible in the URL); we resolve it to the internal UUID server-side. The body's
    // shop_id is overwritten — even if an attacker sends a forged one, it's discarded.
    // Sub-agent dashboard stock purchases still pass shop_id (authenticated branch
    // below); we only require shop_slug when it's a public/unauthenticated request.
    if (shop_slug) {
      const { data: shopRow, error: shopErr } = await supabase
        .from("user_shops")
        .select("id")
        .eq("shop_slug", shop_slug)
        .single()
      if (shopErr || !shopRow) {
        console.warn(`[SHOP-ORDER] ❌ Shop not found for slug=${shop_slug}`)
        return NextResponse.json({ error: "Shop not found" }, { status: 404 })
      }
      // Override any client-provided shop_id with the server-resolved one.
      shop_id = shopRow.id
    }

    // Honeypot: hidden form field that real users never fill. Any non-empty
    // value = bot. Return a generic 400 so attackers can't easily distinguish
    // honeypot rejection from other validation failures.
    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      console.warn(`[SHOP-ORDER] ❌ Honeypot tripped: bot detected for shop ${shop_id} value_len=${honeypot.length}`)
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    // Email quality check: format + bot heuristics (repeated-char local parts like
    // "kkkkkkk", known throwaway domains like "mli.mc"). Near-zero false positives;
    // rejects the current scripted wave before any DB work. NOT a substitute for
    // Cloudflare/Turnstile — a cheap speed bump while the edge defence ramps.
    const emailCheck = checkEmailQuality(customer_email)
    if (!emailCheck.ok) {
      console.warn(`[SHOP-ORDER] ❌ Email rejected (${emailCheck.reason}) for shop ${shop_id}: ${String(customer_email).slice(0, 40)}`)
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 })
    }
    // Ghana phone: 10 digits starting 0, or 9 digits, optionally +233 prefix.
    const phoneDigits = String(customer_phone || "").replace(/\D/g, "")
    const normalizedPhone = phoneDigits.startsWith("233") ? "0" + phoneDigits.slice(3) : phoneDigits
    if (!/^0\d{9}$/.test(normalizedPhone)) {
      console.warn(`[SHOP-ORDER] ❌ Invalid phone format for shop ${shop_id}: ${String(customer_phone).slice(0, 20)}`)
      return NextResponse.json({ error: "Please enter a valid phone number." }, { status: 400 })
    }

    // Bypass cookie + Turnstile checks ONLY for genuine sub-agent stock purchases:
    //   1) Must have a valid Supabase Bearer token, AND
    //   2) Body must declare is_stock_purchase: true, AND
    //   3) The order's target shop (shop_id) must be a sub-agent shop OWNED BY
    //      the authenticated user (user_shops row where id = shop_id AND
    //      user_id = auth.uid() AND parent_shop_id IS NOT NULL).
    //
    // SCOPE NOTE: (3) is bound to the SPECIFIC shop_id being ordered against —
    // not "owns any sub-agent shop". Otherwise an attacker who owns one
    // sub-agent shop could set is_stock_purchase=true against a VICTIM shop's
    // slug and bypass cookie+Turnstile for any shop on the platform. The legit
    // buy-stock flow always orders against the user's own shop, so this is safe.
    let isAuthenticatedDashboardCall = false
    const authHeader = request.headers.get("authorization")
    const isStockPurchaseFlag = body?.is_stock_purchase === true
    if (authHeader?.startsWith("Bearer ") && isStockPurchaseFlag) {
      const token = authHeader.slice(7)
      try {
        const { data: { user } } = await supabase.auth.getUser(token)
        if (user) {
          const { data: ownedSubAgentShop } = await supabase
            .from("user_shops")
            .select("id")
            .eq("id", shop_id)                      // the SPECIFIC shop this order targets
            .eq("user_id", user.id)                 // owned by the caller
            .not("parent_shop_id", "is", null)      // and is a sub-agent shop
            .maybeSingle()
          if (ownedSubAgentShop) {
            isAuthenticatedDashboardCall = true
            console.log(`[SHOP-ORDER] ✓ Verified sub-agent stock purchase by user ${user.id} for own shop ${shop_id}`)
          } else {
            console.warn(`[SHOP-ORDER] ❌ Auth bypass rejected: user ${user.id} does not own sub-agent shop ${shop_id} — falling through to cookie+Turnstile`)
          }
        }
      } catch {
        // Invalid token — fall through to cookie + turnstile checks
      }
    } else if (authHeader?.startsWith("Bearer ") && !isStockPurchaseFlag) {
      console.warn(`[SHOP-ORDER] ⚠️ Auth bypass rejected: Bearer token present but is_stock_purchase != true (likely abuse attempt)`)
    }

    // Turnstile CAPTCHA verification for unauthenticated public traffic.
    // Dashboard sub-agent stock purchases bypass via the Bearer token above.
    // Admin can disable Turnstile globally via /api/admin/settings/turnstile.
    if (!isAuthenticatedDashboardCall) {
      const turnstileEnabled = await isTurnstileEnabled()
      if (!turnstileEnabled) {
        console.warn(`[SHOP-ORDER] ⚠️ Turnstile DISABLED by admin toggle — skipping verification for shop ${shop_id}`)
      } else {
        const turnstileResult = await verifyTurnstileToken(turnstileToken, getRequestIp(request.headers))
        if (!turnstileResult.valid) {
          console.warn(`[SHOP-ORDER] ❌ Turnstile verification failed (${turnstileResult.reason}) for shop ${shop_id} turnstile_configured=${!!process.env.TURNSTILE_SECRET_KEY} token_present=${!!turnstileToken}`)
          return NextResponse.json({ error: "Verification failed. Please refresh the page and try again." }, { status: 403 })
        }
        console.log(`[SHOP-ORDER] ✓ Turnstile passed for shop ${shop_id}`)
      }
    } else {
      console.log(`[SHOP-ORDER] ⊘ Turnstile skipped (authenticated stock purchase) for shop ${shop_id}`)
    }

    // Require __shop_sess cookie that was issued for THIS shop's current slug.
    // Slug binding: a cookie harvested from /shop/A is invalid for ordering at shop B.
    // We look up the shop's current slug from DB so slug-rotation also invalidates cookies.
    if (!isAuthenticatedDashboardCall) {
      const shopCookie = request.cookies.get("__shop_sess")?.value
      if (!shopCookie) {
        console.warn(`[SHOP-ORDER] ❌ Blocked: missing __shop_sess cookie for shop ${shop_id}`)
        return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
      }
      // Pull the shop's current slug for cookie-binding verification
      const { data: shopForCookie } = await supabase
        .from("user_shops")
        .select("shop_slug")
        .eq("id", shop_id)
        .single()
      if (!shopForCookie?.shop_slug) {
        console.warn(`[SHOP-ORDER] ❌ Shop not found for cookie verification: ${shop_id}`)
        return NextResponse.json({ error: "Shop not found" }, { status: 404 })
      }
      const cookieCheck = verifyShopSession(shopCookie, shopForCookie.shop_slug)
      if (!cookieCheck.valid) {
        console.warn(`[SHOP-ORDER] ❌ Invalid shop session cookie (${cookieCheck.reason}) for shop ${shop_id} expected_slug=${shopForCookie.shop_slug} secret_configured=${!!process.env.SHOP_TOKEN_SECRET}`)
        return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
      }
      console.log(`[SHOP-ORDER] ✓ Cookie valid for shop ${shop_id} slug=${shopForCookie.shop_slug}`)
    }

    console.log("[SHOP-ORDER] Creating order for:", {
      shop_id,
      customer_email,
      network,
      total_price,
    })

    // Validate input
    if (!shop_id || !customer_email || !customer_phone || !shop_package_id) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    // CRITICAL SECURITY: Server-side price validation
    // Never trust client-provided prices - always verify against database
    let verifiedBasePrice: number
    let verifiedProfitMargin: number
    let verifiedTotalPrice: number
    let verifiedSize: string = ""

    // Check if this is a sub-agent shop
    const { data: shopData, error: shopError } = await supabase
      .from("user_shops")
      .select("parent_shop_id, user_id, is_blocked")
      .eq("id", shop_id)
      .single()

    if (shopError) {
      console.error("[SHOP-ORDER] Error fetching shop:", shopError)
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    if (shopData?.is_blocked) {
      console.warn("[SHOP-ORDER] ⛔ Order blocked: shop is temporarily blocked", shop_id)
      return NextResponse.json(
        { error: "This shop is temporarily unavailable. Please try again later." },
        { status: 503 }
      )
    }

    if (shopData?.parent_shop_id) {
      // Sub-agent: verify from sub_agent_shop_packages or sub_agent_catalog
      const { data: subAgentPkg, error: subAgentPkgError } = await supabase
        .from("sub_agent_shop_packages")
        .select("parent_price, sub_agent_profit_margin, package_id")
        .eq("id", shop_package_id)
        .single()

      if (!subAgentPkgError && subAgentPkg) {
        verifiedBasePrice = subAgentPkg.parent_price
        verifiedProfitMargin = subAgentPkg.sub_agent_profit_margin || 0
        verifiedTotalPrice = verifiedBasePrice + verifiedProfitMargin
      } else {
        // Fallback to sub_agent_catalog
        const { data: catalogEntry } = await supabase
          .from("sub_agent_catalog")
          .select("parent_price, sub_agent_profit_margin, wholesale_margin, package:packages(size, price, dealer_price)")
          .eq("id", shop_package_id)
          .single()

        if (catalogEntry) {
          // Check if parent is a dealer
          const { data: parentShop } = await supabase
            .from("user_shops")
            .select("user_id")
            .eq("id", shopData.parent_shop_id)
            .single()

          let isParentDealer = false
          if (parentShop) {
            const { data: parentUser } = await supabase
              .from("users")
              .select("role")
              .eq("id", parentShop.user_id)
              .single()
            isParentDealer = parentUser?.role === 'dealer' || parentUser?.role === 'admin'
          }

          const pkg = (catalogEntry.package as any)
          const adminPrice = (isParentDealer && pkg?.dealer_price && pkg?.dealer_price > 0)
            ? pkg.dealer_price
            : (pkg?.price || 0)

          verifiedSize = pkg?.size || ""

          const margin = catalogEntry.wholesale_margin ?? 0
          verifiedBasePrice = adminPrice + margin
          // Sub-agent profit on "Buy Stock" is 0, but for customer orders via sub-agent shop, 
          // we must respect the sub-agent's configured margin if present in catalog
          // Check if this is a stock purchase (restocking)
          const isStockPurchase = body.is_stock_purchase === true

          if (isStockPurchase) {
            verifiedProfitMargin = 0
          } else {
            verifiedProfitMargin = catalogEntry.sub_agent_profit_margin || 0
          }
          verifiedTotalPrice = verifiedBasePrice + verifiedProfitMargin
        } else {
          console.error("[SHOP-ORDER] ❌ Could not verify sub-agent package price")
          return NextResponse.json({ error: "Invalid package" }, { status: 400 })
        }
      }
    } else {
      // Regular shop: verify from shop_packages

      // Check if shop owner is a dealer
      const { data: userData } = await supabase
        .from("users")
        .select("role")
        .eq("id", shopData?.user_id)
        .single()

      const isDealer = userData?.role === 'dealer' || userData?.role === 'admin'


      const { data: shopPkg, error: shopPkgError } = await supabase
        .from("shop_packages")
        .select("profit_margin, packages(size, price, dealer_price)")
        .eq("id", shop_package_id)
        .single()

      if (shopPkgError || !shopPkg) {
        console.error("[SHOP-ORDER] ❌ Could not find shop package:", shopPkgError)
        return NextResponse.json({ error: "Invalid package" }, { status: 400 })
      }

      const pkgPrice = (shopPkg.packages as any)?.price || 0
      const dealerPrice = (shopPkg.packages as any)?.dealer_price
      verifiedSize = (shopPkg.packages as any)?.size || ""

      // If dealer, use dealer_price as base cost
      verifiedBasePrice = isDealer && dealerPrice && dealerPrice > 0 ? dealerPrice : pkgPrice
      verifiedProfitMargin = shopPkg.profit_margin || 0
      verifiedTotalPrice = verifiedBasePrice + verifiedProfitMargin
    }

    // Force server-side verified size to prevent injection/manipulation
    const finalVolumeGb = verifiedSize ? parseInt(verifiedSize.toString().replace(/[^0-9]/g, "")) || volume_gb : volume_gb

    // Validate client-provided prices match server-verified prices
    const tolerance = 0.01 // Allow 1 pesewa tolerance for rounding
    if (Math.abs(total_price - verifiedTotalPrice) > tolerance) {
      console.error(`[SHOP-ORDER] ❌ PRICE MANIPULATION DETECTED!`)
      console.error(`  Client total_price: ${total_price}`)
      console.error(`  Verified total_price: ${verifiedTotalPrice}`)
      console.error(`  Shop ID: ${shop_id}, Package ID: ${shop_package_id}`)

      // Alert admins via SMS (non-blocking)
      notifyPriceManipulation(
        customer_phone,
        total_price,
        verifiedTotalPrice,
        true // skipEmailFallback (explicit email sent below)
      ).catch(err => console.error("[SHOP-ORDER] Failed to notify admins:", err))

      // Alert admins via Email (non-blocking)
      import("@/lib/email-service").then(({ notifyAdmins, EmailTemplates }) => {
        const payload = EmailTemplates.priceManipulationDetected(
          customer_phone,
          total_price.toString(),
          verifiedTotalPrice.toString(),
          network,
          volume_gb.toString()
        );
        notifyAdmins(payload.subject, payload.html).catch(err => {
          console.error("[SHOP-ORDER] ❌ Price Manipulation Email FAILED:", err)
          console.error("[SHOP-ORDER] Error message:", err?.message)
          console.error("[SHOP-ORDER] Error stack:", err?.stack)
          console.error("[SHOP-ORDER] Full error:", JSON.stringify(err, null, 2))
        });
      });

      return NextResponse.json(
        { error: "Invalid price - please refresh and try again" },
        { status: 400 }
      )
    }

    console.log(`[SHOP-ORDER] ✓ Price verified: ${verifiedTotalPrice} GHS`)

    // Use verified prices instead of client-provided ones
    const finalBasePrice = verifiedBasePrice
    const finalProfitAmount = verifiedProfitMargin
    const finalTotalPrice = verifiedTotalPrice

    // NOTE: Customer tracking is now done AFTER payment is confirmed
    // This prevents inflated customer revenue from abandoned orders
    // See: Paystack webhook and wallet/debit route for customer tracking

    // Check if phone number is blacklisted
    let phoneQueue = "default"
    let orderStatus = "pending"
    try {
      const isBlacklisted = await isPhoneBlacklisted(customer_phone)
      if (isBlacklisted) {
        phoneQueue = "blacklisted"
        orderStatus = "blacklisted"
        console.log(`[SHOP-ORDER] Phone ${customer_phone} is blacklisted - setting queue to 'blacklisted' and order_status to 'blacklisted'`)
      }
    } catch (blacklistError) {
      console.warn("[SHOP-ORDER] Error checking blacklist:", blacklistError)
      // Continue with default queue if blacklist check fails
    }

    // Check if this shop has a parent shop (sub-agent scenario)
    let parent_shop_id: string | null = null
    let parent_profit_amount: number | null = null
    let finalShopPackageId = shop_package_id

    try {
      const { data: shopData, error: shopError } = await supabase
        .from("user_shops")
        .select("parent_shop_id")
        .eq("id", shop_id)
        .single()

      if (!shopError && shopData?.parent_shop_id) {
        parent_shop_id = shopData.parent_shop_id

        // For sub-agents, shop_package_id might be from sub_agent_shop_packages
        // We need to find the corresponding shop_packages entry or create one
        if (shop_package_id && package_id) {
          // Try to find if there's a shop_packages entry for this package
          const { data: shopPkg } = await supabase
            .from("shop_packages")
            .select("id")
            .eq("shop_id", shop_id)
            .eq("package_id", package_id)
            .single()

          if (shopPkg) {
            // Use the existing shop_packages ID
            finalShopPackageId = shopPkg.id
          } else {
            // Create a shop_packages entry for this sub-agent's package
            // Get the profit margin from sub_agent_shop_packages
            const { data: subAgentPkg } = await supabase
              .from("sub_agent_shop_packages")
              .select("sub_agent_profit_margin")
              .eq("id", shop_package_id)
              .single()

            const { data: newShopPkg, error: createError } = await supabase
              .from("shop_packages")
              .insert([{
                shop_id,
                package_id,
                profit_margin: subAgentPkg?.sub_agent_profit_margin || 0,
                is_available: true
              }])
              .select("id")
              .single()

            if (!createError && newShopPkg) {
              finalShopPackageId = newShopPkg.id
            } else {
              console.warn("[SHOP-ORDER] Could not create shop_packages entry for sub-agent")
              // Continue without mapping - order creation might fail if FK is enforced
            }
          }
        }

        // Calculate parent's profit: the wholesale_margin from sub_agent_catalog
        // Parent profit = wholesale_margin (what parent charges above admin price)
        // NOT base_price - admin_price (that's the sub-agent's total margin)
        console.log(`[SHOP-ORDER] Looking up catalog for parent_shop_id=${parent_shop_id}, package_id=${package_id}`)

        // Check if parent is a dealer for profit calculation
        const { data: parentShop } = await supabase
          .from("user_shops")
          .select("user_id")
          .eq("id", parent_shop_id)
          .single()

        let isParentDealer = false
        if (parentShop) {
          const { data: parentUser } = await supabase
            .from("users")
            .select("role")
            .eq("id", parentShop.user_id)
            .single()
          isParentDealer = parentUser?.role === 'dealer' || parentUser?.role === 'admin'
        }

        const { data: catalogEntry, error: catalogError } = await supabase
          .from("sub_agent_catalog")
          .select("wholesale_margin, parent_price, package:packages(price, dealer_price)")
          .eq("shop_id", parent_shop_id)
          .eq("package_id", package_id)
          .single()

        if (catalogEntry) {
          const pkg = (catalogEntry.package as any)
          const adminCost = (isParentDealer && pkg?.dealer_price && pkg?.dealer_price > 0)
            ? pkg.dealer_price
            : (pkg?.price || 0)

          parent_profit_amount = catalogEntry.wholesale_margin || 0

          // Double check: if parent_price is stored, it should be adminCost + wholesale_margin
          console.log(`[SHOP-ORDER] Sub-agent parent profit: Parent Margin(${parent_profit_amount}) based on Admin Cost(${adminCost})`)
        } else {
          parent_profit_amount = 0
          console.warn(`[SHOP-ORDER] No catalog entry found for parent profit calculation`)
        }

        console.log(`[SHOP-ORDER] Sub-agent sale detected. Parent shop: ${parent_shop_id}, Parent profit: ${parent_profit_amount}`)
      }
    } catch (parentError) {
      console.warn("[SHOP-ORDER] Error checking for parent shop:", parentError)
      // Continue without parent - profit will only go to sub-agent
    }

    // Atomic flood guards via Upstash sliding window — closes the count→insert
    // race where parallel requests all see count<cap and all insert. Each Upstash
    // increment is atomic at the Lua-script level. Fails open if Upstash is
    // misconfigured (the DB count below remains as fallback).
    const [emailCap, phoneCap, shop5mCap, shop1hCap] = await Promise.all([
      applyRateLimit(request, "shop_order_cap_email", 5, 60 * 60 * 1000, `e:${customer_email.toLowerCase()}`),
      applyRateLimit(request, "shop_order_cap_phone", 5, 60 * 60 * 1000, `p:${customer_phone}`),
      applyRateLimit(request, "shop_order_cap_shop_5m", 15, 5 * 60 * 1000, `s:${shop_id}`),
      applyRateLimit(request, "shop_order_cap_shop_1h", 60, 60 * 60 * 1000, `s:${shop_id}`),
    ])
    if (!emailCap.allowed || !phoneCap.allowed) {
      console.warn(`[SHOP-ORDER] ❌ Atomic cap hit (email_allowed=${emailCap.allowed} phone_allowed=${phoneCap.allowed}) for shop ${shop_id}`)
      return NextResponse.json(
        { error: "Too many pending orders. Please complete or wait for existing orders to expire." },
        { status: 429 }
      )
    }
    if (!shop5mCap.allowed || !shop1hCap.allowed) {
      console.warn(`[SHOP-ORDER] ❌ Atomic shop cap hit (5m_allowed=${shop5mCap.allowed} 1h_allowed=${shop1hCap.allowed}) for shop ${shop_id}`)
      return NextResponse.json(
        { error: "Too many pending orders for this shop. Please try again shortly." },
        { status: 429 }
      )
    }

    // DB-level flood guards — backup defence active even if Upstash misconfigured.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    const [{ count: pendingByEmail }, { count: pendingByPhone }, { count: pendingByShop5m }, { count: pendingByShop1h }] = await Promise.all([
      // Same email: max 5 pending in last hour (covers buying for ~5 family members + payment retries)
      supabase
        .from("shop_orders")
        .select("id", { count: "exact", head: true })
        .eq("customer_email", customer_email)
        .eq("payment_status", "pending")
        .gte("created_at", oneHourAgo),
      // Same phone: max 5 pending in last hour (covers payment failures + retries)
      supabase
        .from("shop_orders")
        .select("id", { count: "exact", head: true })
        .eq("customer_phone", customer_phone)
        .eq("payment_status", "pending")
        .gte("created_at", oneHourAgo),
      // Same shop: max 15 pending in last 5 minutes (burst cap)
      supabase
        .from("shop_orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shop_id)
        .eq("payment_status", "pending")
        .gte("created_at", fiveMinutesAgo),
      // Same shop: max 60 pending in last hour (sustained cap)
      supabase
        .from("shop_orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shop_id)
        .eq("payment_status", "pending")
        .gte("created_at", oneHourAgo),
    ])

    if ((pendingByEmail ?? 0) >= 5 || (pendingByPhone ?? 0) >= 5) {
      return NextResponse.json(
        { error: "Too many pending orders. Please complete or wait for existing orders to expire." },
        { status: 429 }
      )
    }
    if ((pendingByShop5m ?? 0) >= 15 || (pendingByShop1h ?? 0) >= 60) {
      return NextResponse.json(
        { error: "Too many pending orders for this shop. Please try again shortly." },
        { status: 429 }
      )
    }

    const { data, error } = await supabase
      .from("shop_orders")
      .insert([
        {
          shop_id,
          customer_email,
          customer_phone,
          customer_name: customer_name || "Guest",
          shop_package_id: finalShopPackageId,
          package_id,
          network,
          volume_gb: finalVolumeGb,
          base_price: finalBasePrice,
          profit_amount: finalProfitAmount,
          total_price: finalTotalPrice,
          order_status: orderStatus,
          payment_status: "pending",
          reference_code: secureTimestampedReference("ORD"),
          shop_customer_id: null, // Will be set when payment is confirmed
          parent_shop_id: parent_shop_id || null,
          parent_profit_amount: parent_profit_amount !== null ? parseFloat(parent_profit_amount.toString()) : 0,
          queue: phoneQueue,
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (error) {
      console.error("[SHOP-ORDER] Database error:", error)
      throw new Error(`Failed to create order: ${error.message}`)
    }

    if (!data || data.length === 0) {
      throw new Error("Failed to create order: No data returned")
    }

    console.log("[SHOP-ORDER] ✓ Order created:", data[0].id, {
      parent_shop_id: data[0].parent_shop_id,
      parent_profit_amount: data[0].parent_profit_amount
    })

    // Anomaly alert: notify admins if pending orders spike (non-blocking, no hard block)
    // Threshold 80/hr chosen so a busy legitimate shop (60/hr cap) never trips this.
    ;(async () => {
      try {
        const oneHourAgoCheck = new Date(Date.now() - 60 * 60 * 1000).toISOString()
        const { count: hourlyPending } = await supabase
          .from("shop_orders")
          .select("id", { count: "exact", head: true })
          .eq("shop_id", shop_id)
          .eq("payment_status", "pending")
          .gte("created_at", oneHourAgoCheck)

        if ((hourlyPending ?? 0) >= 80) {
          console.warn(`[SHOP-ORDER] 🚨 Anomaly alert: shop ${shop_id} has ${hourlyPending} pending orders in last hour — possible scripted flooding`)
          import("@/lib/email-service").then(({ notifyAdmins }) => {
            notifyAdmins(
              `🚨 Shop flood alert — ${shop_id}`,
              `<p>Shop <strong>${shop_id}</strong> has <strong>${hourlyPending}</strong> pending orders in the last hour.</p><p>This may indicate a scripted attack. Review and block manually if confirmed.</p>`
            ).catch(() => {})
          })
        }
      } catch (e) {
        console.warn("[SHOP-ORDER] Anomaly check failed (non-critical):", e)
      }
    })()

    // NOTE: Blacklist notification SMS and admin alerts are sent AFTER payment verification
    // See: webhook and payment verify endpoints for SMS delivery

    return NextResponse.json({
      success: true,
      order: data[0],
    })
  } catch (error) {
    console.error("[SHOP-ORDER] ✗ Error:", error)
    return NextResponse.json(
      { error: "Failed to create order. Please try again." },
      { status: 500 }
    )
  }
}
