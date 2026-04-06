import { NextRequest, NextResponse } from "next/server"

/**
 * Verifies that a cron request is authorized via CRON_SECRET.
 * Vercel automatically sends Authorization: Bearer <CRON_SECRET> for cron jobs.
 * Set CRON_SECRET in your Vercel environment variables.
 */
export function verifyCronAuth(request: NextRequest): { authorized: boolean; errorResponse?: NextResponse } {
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    console.error("[CRON-AUTH] CRON_SECRET environment variable is not set — blocking request")
    return {
      authorized: false,
      errorResponse: NextResponse.json({ error: "Cron not configured" }, { status: 500 }),
    }
  }

  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${cronSecret}`) {
    console.warn("[CRON-AUTH] Unauthorized cron request blocked")
    return {
      authorized: false,
      errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    }
  }

  return { authorized: true }
}
