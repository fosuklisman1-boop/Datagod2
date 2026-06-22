import { NextRequest, NextResponse } from "next/server"

/**
 * Verifies that a cron request is authorized.
 *
 * REQUIRES `Authorization: Bearer <CRON_SECRET>`. Vercel sends this header
 * automatically on every scheduled invocation when `CRON_SECRET` is set in the
 * project env (it is), so genuine crons authenticate transparently.
 *
 * SECURITY: the old `x-vercel-cron` fallback was removed — that header is NOT
 * stripped from external requests on this deployment, so any anonymous client
 * could forge `x-vercel-cron: 1` and invoke every cron route (data leak + live
 * payment/provider side effects). The only secret is CRON_SECRET; if it is unset
 * we fail CLOSED (block) rather than trust a forgeable header. Keep CRON_SECRET
 * set in Vercel env and bound to the cron schedules.
 */
export function verifyCronAuth(request: NextRequest): { authorized: boolean; errorResponse?: NextResponse } {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { authorized: true }
  }

  if (!cronSecret) {
    console.error("[CRON-AUTH] CRON_SECRET is not set — failing closed. Set it in Vercel env.")
  } else {
    console.warn("[CRON-AUTH] Unauthorized cron request blocked (no valid Bearer CRON_SECRET)")
  }
  return {
    authorized: false,
    errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  }
}
