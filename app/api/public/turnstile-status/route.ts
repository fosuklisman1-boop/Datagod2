import { NextResponse } from "next/server"
import { isTurnstileEnabled } from "@/lib/turnstile"

/**
 * GET /api/public/turnstile-status
 * Public endpoint — returns { enabled: boolean } so the storefront forms
 * know whether to render the Turnstile widget. No auth required because
 * the answer is the same for every visitor.
 *
 * Cached at the edge for 30 seconds: an admin toggle takes effect on
 * existing pages within 30s of a hard refresh. New page loads after the
 * toggle pick up the new state immediately (TTL only affects previously-
 * cached responses).
 */
export async function GET() {
  const enabled = await isTurnstileEnabled()
  return NextResponse.json(
    { enabled },
    {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    }
  )
}
