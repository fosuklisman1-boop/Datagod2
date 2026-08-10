// Admin endpoint: batch-verify MTN numbers from mtn_number_registry against
// all configured whitelist providers (Xpress, Codecraft, AgentPortalGH).
// Paginated — call repeatedly with increasing ?offset until done=true.
// POST body: { offset?: number, limit?: number, providers?: "xpress,codecraft,agentportalgh" (comma-separated, default = all configured) }
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { WHITELIST_REGISTRY, checkWhitelistBatch, unionProviders } from "@/lib/mtn-providers/provider-whitelist"

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
  const attemptedProviders = configuredProviders.map(p => p.name)

  // Fetch existing checked-providers per phone so the write below unions
  // rather than overwrites — this endpoint and the phone-verification upload
  // flow both touch whitelist_checked_providers, and neither should erase
  // what the other already recorded.
  const existingCheckedProviders = new Map<string, string[]>()
  for (let i = 0; i < phones.length; i += 500) {
    const chunk = phones.slice(i, i + 500)
    const { data: existingRows, error: existingError } = await supabase
      .from("mtn_number_registry")
      .select("phone, whitelist_checked_providers")
      .in("phone", chunk)
    if (existingError) {
      console.error("[MTN-WHITELIST-BATCH-VERIFY] checked-providers lookup failed (falling back to empty history for this chunk):", existingError.message)
      continue
    }
    for (const row of existingRows ?? []) {
      existingCheckedProviders.set(row.phone, row.whitelist_checked_providers ?? [])
    }
  }

  let allowedCount = 0
  let blockedCount = 0
  const upsertRows = phones.map(phone => {
    const r = results.get(phone)
    const allowed = r?.allowed === true
    if (allowed) allowedCount++
    else blockedCount++
    return {
      phone,
      whitelist_status: allowed ? ("allowed" as const) : ("blocked" as const),
      whitelist_allowed_by: allowed ? (r?.allowedBy ?? null) : null,
      whitelist_last_checked: now,
      whitelist_retry_count: 0,
      whitelist_checked_providers: unionProviders(existingCheckedProviders.get(phone) ?? [], attemptedProviders),
    }
  })

  for (let i = 0; i < upsertRows.length; i += 500) {
    const { error: upsertError } = await supabase
      .from("mtn_number_registry")
      .upsert(upsertRows.slice(i, i + 500), { onConflict: "phone" })
    if (upsertError) console.error("[MTN-WHITELIST-BATCH-VERIFY] registry upsert failed:", upsertError.message)
  }

  const total = count ?? 0
  const nextOffset = offset + phones.length
  const done = nextOffset >= total

  return NextResponse.json({
    ok: true,
    done,
    processed: phones.length,
    allowed: allowedCount,
    blocked: blockedCount,
    nextOffset,
    total,
  })
}
