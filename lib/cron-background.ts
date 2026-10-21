import { NextRequest, NextResponse, after } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"

/**
 * Wraps a cron route so the scheduler gets an answer immediately and the real
 * work finishes after the response.
 *
 * Why: cron-job.org gives up on a request after 30s and records a failure, but
 * some sync routes legitimately run longer (e.g. 50 provider polls at 1/s). With
 * this wrapper the caller always sees a fast 202 and the route keeps its full
 * maxDuration to finish.
 *
 * The cron secret is checked BEFORE any work is accepted, so an unauthenticated
 * caller still gets 401. The wrapped handler runs its own auth check again with
 * the same request - harmless, and keeps each route self-protecting.
 *
 * Trade-off: the scheduler can no longer see handler failures (it always sees
 * 202). Failures are logged here, prefixed [CRON-BG:<label>].
 */
export function backgroundCron(
  label: string,
  handler: (request: NextRequest) => Promise<Response | undefined | void>,
): (request: NextRequest) => Promise<Response> {
  return async (request: NextRequest) => {
    const { authorized, errorResponse } = verifyCronAuth(request)
    if (!authorized) return errorResponse!

    after(async () => {
      try {
        const res = await handler(request)
        if (res && !res.ok) console.error(`[CRON-BG:${label}] handler returned ${res.status}`)
      } catch (err) {
        console.error(`[CRON-BG:${label}] handler threw:`, err)
      }
    })

    return NextResponse.json({ accepted: true }, { status: 202 })
  }
}
