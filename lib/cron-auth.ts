import { NextRequest, NextResponse } from "next/server"

/**
 * Verifies that a cron request is authorized.
 *
 * Primary check: `Authorization: Bearer <CRON_SECRET>` — Vercel sends this
 * automatically on scheduled invocations WHEN `CRON_SECRET` is set in env.
 *
 * Fallback: the `x-vercel-cron` header. Vercel adds this to genuine cron
 * invocations and strips it from external client requests, so it identifies a
 * real scheduled run even if `CRON_SECRET` was never set or got rotated. This
 * is what prevents a missing secret from silently killing EVERY cron (which is
 * exactly what made auto-sync stop). External callers — no secret match and no
 * `x-vercel-cron` — are still blocked with 401.
 */
export function verifyCronAuth(request: NextRequest): { authorized: boolean; errorResponse?: NextResponse } {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")

  // 1) Explicit secret match (preferred — set CRON_SECRET in Vercel)
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { authorized: true }
  }

  // 2) Genuine Vercel cron invocation (header not forwardable by external clients)
  if (request.headers.get("x-vercel-cron")) {
    if (!cronSecret) {
      console.warn("[CRON-AUTH] Allowing Vercel cron via x-vercel-cron header — set CRON_SECRET for stricter auth.")
    }
    return { authorized: true }
  }

  console.warn("[CRON-AUTH] Unauthorized cron request blocked (no CRON_SECRET match, no x-vercel-cron header)")
  return {
    authorized: false,
    errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  }
}
