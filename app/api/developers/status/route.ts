import { NextResponse } from "next/server"
import { getPublicStatus } from "@/lib/api-v2/status-public"

export const dynamic = "force-dynamic"

// Public, no auth, no cookies. Query parameters are ignored (spec 7.1); the module keeps a 60 s in-memory copy.
export async function GET(_req: Request) {
  const status = await getPublicStatus()
  if (status === "error") {
    return NextResponse.json({ error: "Status is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
  return NextResponse.json(status, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } })
}
