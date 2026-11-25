/**
 * Session plumbing shared by the Release 3 developer-dashboard routes (/api/user/v2-dashboard/*). Dashboard session only:
 * an API key is not a session (getUser rejects it), so a leaked key can never read the dashboard. Each route calls
 * requireCapability(..., "account.api") itself (the capability-route guard checks every route file for it).
 */
import { NextResponse, type NextRequest } from "next/server"
import { getAdminClient } from "@/lib/api-v2/store"
import { applyRateLimit } from "@/lib/rate-limiter"

export const NO_STORE = { "Cache-Control": "no-store" }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const dashboardClient = (): any => getAdminClient()

/** The verified session user, or null. Never reads a user id from the request body or query. */
export async function getSessionUser(request: NextRequest): Promise<{ id: string } | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return null
  try {
    const { data } = await dashboardClient().auth.getUser(token)
    return typeof data?.user?.id === "string" ? { id: data.user.id } : null
  } catch {
    return null
  }
}

export const unauthorized = () => NextResponse.json({ error: "Sign in to see your API dashboard." }, { status: 401, headers: NO_STORE })

/** Per-person read budget for the dashboard reads; returns the 429 response or null. */
export async function readLimited(request: NextRequest, userId: string, name: string, max: number, windowMs: number): Promise<NextResponse | null> {
  const r = await applyRateLimit(request, name, max, windowMs, userId)
  return r.allowed ? null : NextResponse.json({ error: "Too many requests. Wait a moment and try again.", code: "rate_limited" }, { status: 429, headers: NO_STORE })
}

export const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: NO_STORE })
