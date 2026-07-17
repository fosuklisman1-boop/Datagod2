// Admin endpoint: batch-verify MTN numbers from mtn_number_registry against
// Xpress and/or Codecraft whitelist APIs.
// Paginated — call repeatedly with increasing ?offset until done=true.
// POST body: { offset?: number, limit?: number, provider?: "xpress"|"codecraft"|"both" }
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { WHITELIST_REGISTRY } from "@/lib/mtn-providers/provider-whitelist"

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
  // Optional filter: only run specific providers (comma-separated names), default = all configured
  const providerFilter: string[] = body.providers
    ? String(body.providers).split(",").map((s: string) => s.trim())
    : []

  const configuredProviders = WHITELIST_REGISTRY.filter(
    p => p.configured() && (providerFilter.length === 0 || providerFilter.includes(p.name))
  )
  if (configuredProviders.length === 0) {
    return NextResponse.json({ error: "No whitelist providers configured" }, { status: 400 })
  }

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

  // Run each provider's batch check in sequence; once a number is allowed, skip it for later providers
  for (const entry of configuredProviders) {
    const toCheck = phones.filter(p => !allowed.has(p))
    if (toCheck.length === 0) break
    const results = await entry.checkBatch(toCheck)
    for (const r of results) {
      if (r.allowed) allowed.add(r.msisdn)
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
