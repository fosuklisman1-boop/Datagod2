/**
 * Admin "Check all providers": a number that ANY configured whitelist provider allows is let through
 * checkout (owner decision 2026-11-21). The permanent verified verdict is written and READ BACK first; only
 * phones that read back true are flipped to allowed (guarded on status). A row must never be Ready (customer
 * texted) while checkout still refuses it, so a cache write/read failure flips nothing for that phone and is
 * reported as cacheFailed. If the guarded update then matches nothing (admin changed the row meanwhile) a
 * harmless verified cache entry remains. The verified key is the number alone, so checkout lets it through
 * whatever the checkout provider list is. Logs carry counts only.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { getCustomerVerificationSettings } from "@/lib/mtn-providers/customer-verification"
import { getCachedVerdicts, setCachedVerdicts } from "@/lib/mtn-providers/verdict-cache"

const TABLE = "mtn_blocked_numbers"
const CHUNK = 500

export type AdminAllowRow = { id: string; phone: string; allowedBy: string }

export type AdminAllowDeps = {
  db: SupabaseClient
  now(): Date
  setCache: typeof setCachedVerdicts
  getCache: typeof getCachedVerdicts
  getCheckoutProviders(): Promise<string[]>
}

const realDeps = (): AdminAllowDeps => ({
  db: supabaseAdmin,
  now: () => new Date(),
  setCache: setCachedVerdicts,
  getCache: getCachedVerdicts,
  getCheckoutProviders: async () => (await getCustomerVerificationSettings()).providers,
})

export type AdminAllowResult = { updatedIds: string[]; failed: boolean; cacheFailed: number }

export async function markAllowedByAdminCheck(
  rows: AdminAllowRow[],
  deps: AdminAllowDeps = realDeps()
): Promise<AdminAllowResult> {
  if (rows.length === 0) return { updatedIds: [], failed: false, cacheFailed: 0 }
  const nowIso = deps.now().toISOString()

  // (1) write and (2) read back the verified verdict; keep only phones that read back true.
  let eligible: AdminAllowRow[] = []
  try {
    const providers = await deps.getCheckoutProviders()
    const phones = [...new Set(rows.map((r) => r.phone))]
    await deps.setCache(new Map(phones.map((p) => [p, true])), providers)
    const back = await deps.getCache(phones, providers)
    eligible = rows.filter((r) => back.get(r.phone) === true)
  } catch {
    console.error("[BLOCKED-ADMIN] verdict cache write/read-back failed")
  }
  const cacheFailed = rows.length - eligible.length
  let failed = cacheFailed > 0
  const updatedIds: string[] = []

  // (3) only then flip the status.
  for (let i = 0; i < eligible.length; i += CHUNK) {
    const chunk = eligible.slice(i, i + CHUNK)
    // Rows sharing a provider are updated together; allowed_by differs per provider.
    const byProvider = new Map<string, AdminAllowRow[]>()
    for (const r of chunk) byProvider.set(r.allowedBy, [...(byProvider.get(r.allowedBy) ?? []), r])
    for (const [provider, group] of byProvider) {
      const { data, error } = await deps.db
        .from(TABLE)
        .update({ status: "allowed", allowed_at: nowIso, allowed_by: provider, updated_at: nowIso })
        .in("id", group.map((r) => r.id))
        .in("status", ["blocked", "expired"])
        .select("id")
      if (error) {
        failed = true
        console.error("[BLOCKED-ADMIN] direct allow failed:", (error as { code?: string }).code ?? "db")
        continue
      }
      for (const u of (data ?? []) as Array<{ id: string }>) updatedIds.push(u.id)
    }
  }

  console.log(`[BLOCKED-ADMIN] direct allow requested=${rows.length} updated=${updatedIds.length} cacheFailed=${cacheFailed} failed=${failed}`)
  return { updatedIds, failed, cacheFailed }
}
