import { type NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { generateShopSession } from "@/lib/shop-token-edge"
import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"

// Per-IP cookie-issuance rate limit. Real customers refresh a handful of cookies
// per browsing session (visit, navigate to checkout, etc.). Attackers harvesting
// fresh cookies for each scripted order burn through this in seconds → 429.
const cookieIssuanceRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null
const cookieIssuanceLimiter = cookieIssuanceRedis
  ? new Ratelimit({
      redis: cookieIssuanceRedis,
      limiter: Ratelimit.slidingWindow(30, "1 h"),
      prefix: "shop_cookie_issue",
    })
  : null

export async function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID())
  const path = request.nextUrl.pathname

  // Builds request headers that include the nonce for the layout server component.
  const buildRequestHeaders = () => {
    const h = new Headers(request.headers)
    h.set("x-nonce", nonce)
    return h
  }

  // Start with a base response. If Supabase needs to refresh the session cookie,
  // the setAll callback below will replace this with a new response that carries
  // the refreshed cookie — so always use the `response` variable, not this initial value.
  let response = NextResponse.next({ request: { headers: buildRequestHeaders() } })

  // SSR Supabase client — reads from and writes to request/response cookies.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Propagate refreshed session cookies to both the forwarded request
          // and the outgoing response so downstream components see the new token.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request: { headers: buildRequestHeaders() } })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    },
  )

  // getSession() is a local JWT decode — no network round-trip.
  // Individual API routes perform the authoritative getUser() check before serving data.
  const { data: { session } } = await supabase.auth.getSession()
  const isAuthenticated = !!session

  // ── Server-side route guards ────────────────────────────────────────────────
  // Unauthenticated users trying to reach protected pages are redirected to login
  // before any HTML is sent — closing the client-side-only-protection gap.
  if (!isAuthenticated && (path.startsWith("/admin") || path.startsWith("/dashboard"))) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = "/auth/login"
    loginUrl.searchParams.set("redirect", path)
    return NextResponse.redirect(loginUrl)
  }

  // Authenticated users navigating to auth pages are bounced to the dashboard,
  // EXCEPT /auth/reset-password: Supabase's magic-link flow signs the user in
  // via the OTP token before they land on that page, so it must stay accessible.
  if (isAuthenticated && path.startsWith("/auth") && !path.startsWith("/auth/reset-password")) {
    const dashboardUrl = request.nextUrl.clone()
    dashboardUrl.pathname = "/dashboard"
    dashboardUrl.searchParams.delete("redirect")
    return NextResponse.redirect(dashboardUrl)
  }

  // ── Security headers ────────────────────────────────────────────────────────
  const csp = [
    "default-src 'self'",
    // 'unsafe-inline' kept for legacy browsers; ignored by CSP2+ when nonce present.
    // 'strict-dynamic' propagates trust to scripts loaded dynamically by a nonce-d script
    // (covers GTM injected by PostHog, Paystack's Pusher loader, etc.).
    // 'unsafe-eval' intentionally removed — Next.js production builds don't need it.
    `script-src 'self' 'unsafe-inline' 'nonce-${nonce}' 'strict-dynamic' https://js.paystack.co https://checkout.paystack.com https://www.googletagmanager.com https://storage.googleapis.com https://challenges.cloudflare.com`,
    "style-src 'self' 'unsafe-inline' https://paystack.com https://checkout.paystack.com https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    "frame-src https://checkout.paystack.com https://challenges.cloudflare.com",
    // frame-ancestors replaces X-Frame-Options; keep both for broad compatibility.
    "frame-ancestors 'self' https://js.paystack.co",
    "worker-src 'self' blob:",
    "connect-src 'self' https://js.paystack.co https://api.paystack.co https://paystack.com https://checkout.paystack.com https://supabase.co https://*.supabase.co wss://*.supabase.co https://storage.googleapis.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://www.google-analytics.com https://www.googletagmanager.com https://challenges.cloudflare.com",
    // Harden against injection via object/data URIs and base-tag hijacking.
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ")

  response.headers.set("Content-Security-Policy", csp)
  // Isolates the top-level window from cross-origin pop-ups (e.g. XS-Leaks).
  // 'same-origin-allow-popups' keeps Paystack's checkout pop-up working.
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
  // Deny access to sensitive browser APIs from this origin.
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

  // ── Shop session cookie ─────────────────────────────────────────────────────
  // Set __shop_sess on any /shop/<slug>* page load, bound to that specific slug.
  // The order endpoints require this cookie to be present, signature-valid, AND
  // its embedded slug to match the order's target shop slug. This blocks both
  // (a) scripts hitting the API without loading the shop page, and (b) using one
  // harvested cookie to attack multiple shops.
  const shopMatch = path.match(/^\/shop\/([^/]+)/)
  if (shopMatch) {
    const slug = decodeURIComponent(shopMatch[1])

    // Per-IP cookie-issuance rate limit — caps harvest throughput.
    let issuanceAllowed = true
    if (cookieIssuanceLimiter) {
      const ip =
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-real-ip") ||
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown"
      try {
        const { success } = await cookieIssuanceLimiter.limit(ip)
        if (!success) {
          issuanceAllowed = false
          console.warn(`[MIDDLEWARE] Cookie issuance rate-limited for IP=${ip} slug=${slug}`)
        }
      } catch (e) {
        // Fail open — Redis hiccup shouldn't block legitimate browsing.
      }
    }

    if (issuanceAllowed) {
      try {
        const token = await generateShopSession(slug)
        response.cookies.set("__shop_sess", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 10 * 60,
          path: "/",
        })
      } catch (e) {
        console.error("[MIDDLEWARE] Failed to set __shop_sess cookie:", e instanceof Error ? e.message : e)
      }
    }
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon-v2.jpeg (favicon file)
     * - public (public files)
     */
    "/((?!api|_next/static|_next/image|favicon-v2.jpeg|public).*)",
  ],
}
