// Admin endpoint: batch-verify MTN numbers from mtn_number_registry against
// all configured whitelist providers (Xpress, Codecraft, AgentPortalGH).
// Paginated — call repeatedly with increasing ?offset until done=true.
// POST body: { offset?: number, limit?: number, providers?: "xpress,codecraft,agentportalgh" (comma-separated, default = all configured) }
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { WHITELIST_REGISTRY, checkWhitelistBatch } from "@/lib/mtn-providers/provider-whitelist"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

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

  const results = await checkWhitelistBatch(phones, configuredProviders)

  const now = new Date().toISOString()
  const allowedPhones: string[] = []
  const blockedPhones: string[] = []
  // Group allowed phones by which provider allowed them so whitelist_allowed_by
  // is recorded per number (the previous inline loop never set this column).
  const allowedByProvider = new Map<string, string[]>()

  for (const phone of phones) {
    const r = results.get(phone)
    if (r?.allowed) {
      allowedPhones.push(phone)
      const provider = r.allowedBy ?? "unknown"
      if (!allowedByProvider.has(provider)) allowedByProvider.set(provider, [])
      allowedByProvider.get(provider)!.push(phone)
    } else {
      blockedPhones.push(phone)
    }
  }

  for (const [provider, phonesForProvider] of allowedByProvider) {
    await supabase.from("mtn_number_registry")
      .update({ whitelist_status: "allowed", whitelist_allowed_by: provider, whitelist_last_checked: now, whitelist_retry_count: 0 })
      .in("phone", phonesForProvider)
  }
  if (blockedPhones.length > 0) {
    await supabase.from("mtn_number_registry")
      .update({ whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_last_checked: now, whitelist_retry_count: 0 })
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
