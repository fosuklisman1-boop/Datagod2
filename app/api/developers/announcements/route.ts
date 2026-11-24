import { NextResponse } from "next/server"
import { getPublicAnnouncements } from "@/lib/api-v2/announcements"

export const dynamic = "force-dynamic"

// Public, no auth, no cookies. Active announcements only; text is plain and rendered as text by the banner.
export async function GET(_req: Request) {
  const announcements = await getPublicAnnouncements()
  return NextResponse.json({ announcements }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } })
}
