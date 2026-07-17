// Admin endpoint: batch-verify MTN numbers from mtn_number_registry against
// Xpress and/or Codecraft whitelist APIs.
// Paginated — call repeatedly with increasing ?offset until done=true.
// POST body: { offset?: number, limit?: number, provider?: "xpress"|"codecraft"|"both" }
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  checkXpressWhitelistBatch,
  checkCodecraftWhitelistBatch,
} from "@/lib/mtn-providers/provider-whitelist"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const authErr = await verifyAdminAccess(request)
  if (authErr) return authErr

  const body = await request.json().catch(() => ({}))
  const offset = Number(body.offset ?? 0)
  const limit = Number(body.limit ?? 1000)
  const provider: "xpress" | "codecraft" | "both" = body.provider ?? "both"

  // Fetch a page of numbers to verify
  const { data: rows, error, count } = await supabase
    .from("mtn_number_registry")
    .select("phone", { count: "exact" })
    .range(offset, offset + limit - 1)
    .order("phone")

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const phones = (rows ?? []).map(r => r.phone as string)
  if (phones.length === 0) return NextResponse.json({ ok: true, done: true, total: count ?? 0 })

  const allowed = new Set<string>()
  const blockedBy: Record<string, string> = {}

  // Run selected provider(s) batch check
  if (provider === "xpress" || provider === "both") {
    if (process.env.XPRESS_KEY) {
      const results = await checkXpressWhitelistBatch(phones)
      for (const r of results) {
        if (r.allowed) allowed.add(r.msisdn)
        else if (!allowed.has(r.msisdn)) blockedBy[r.msisdn] = "xpress"
      }
    }
  }
  if (provider === "codecraft" || provider === "both") {
    if (process.env.CODECRAFT_API_KEY) {
      // Only re-check numbers not yet allowed by xpress
      const toCheck = provider === "both" ? phones.filter(p => !allowed.has(p)) : phones
      if (toCheck.length > 0) {
        const results = await checkCodecraftWhitelistBatch(toCheck)
        for (const r of results) {
          if (r.allowed) {
            allowed.add(r.msisdn)
            delete blockedBy[r.msisdn]
          } else if (!allowed.has(r.msisdn)) {
            blockedBy[r.msisdn] = blockedBy[r.msisdn]
              ? `${blockedBy[r.msisdn]}+codecraft`
              : "codecraft"
          }
        }
      }
    }
  }

  // Batch update the registry
  const now = new Date().toISOString()
  const allowedPhones = [...allowed]
  const blockedPhones = phones.filter(p => !allowed.has(p))

  if (allowedPhones.length > 0) {
    await supabase.from("mtn_number_registry")
      .update({ whitelist_status: "allowed", whitelist_last_checked: now, whitelist_retry_count: 0 })
      .in("phone", allowedPhones)
  }
  if (blockedPhones.length > 0) {
    await supabase.from("mtn_number_registry")
      .update({ whitelist_status: "blocked", whitelist_last_checked: now, whitelist_retry_count: 0 })
      .in("phone", blockedPhones)
  }

  const total = count ?? 0
  const nextOffset = offset + phones.length
  const done = nextOffset >= total

  return NextResponse.json({
    ok: true,
    done,
    processed: phones.length,
    allowed: allowedPhones.length,
    blocked: blockedPhones.length,
    nextOffset,
    total,
  })
}
