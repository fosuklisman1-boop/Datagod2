/**
 * Admin "Check all providers": a number that ANY configured whitelist provider allows is let through
 * checkout (owner decision 2026-11-21). The row is flipped to allowed directly (guarded on status) and the
 * permanent verified verdict is cached for exactly the rows that were updated. The verified cache key is
 * the number alone, so checkout lets it through whatever the checkout provider list is. Errors never mark
 * anything allowed. Logs carry counts only.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { getCustomerVerificationSettings } from "@/lib/mtn-providers/customer-verification"
import { setCachedVerdicts } from "@/lib/mtn-providers/verdict-cache"

const TABLE = "mtn_blocked_numbers"
const CHUNK = 500

export type AdminAllowRow = { id: string; phone: string; allowedBy: string }

export type AdminAllowDeps = {
  db: SupabaseClient
  now(): Date
  setCache: typeof setCachedVerdicts
  getCheckoutProviders(): Promise<string[]>
}

const realDeps = (): AdminAllowDeps => ({
  db: supabaseAdmin,
  now: () => new Date(),
  setCache: setCachedVerdicts,
  getCheckoutProviders: async () => (await getCustomerVerificationSettings()).providers,
})

export async function markAllowedByAdminCheck(
  rows: AdminAllowRow[],
  deps: AdminAllowDeps = realDeps()
): Promise<{ updatedIds: string[]; failed: boolean }> {
  if (rows.length === 0) return { updatedIds: [], failed: false }
  const nowIso = deps.now().toISOString()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const updatedIds: string[] = []
  const verified = new Map<string, boolean>()
  let failed = false

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    // Rows sharing a provider are updated together; allowed_by differs per provider.
    const byProvider = new Map<string, AdminAllowRow[]>()
    for (const r of chunk) byProvider.set(r.allowedBy, [...(byProvider.get(r.allowedBy) ?? []), r])
    for (const [provider, group] of byProvider) {
      const { data, error } = await deps.db
        .from(TABLE)
        .update({ status: "allowed", allowed_at: nowIso, allowed_by: provider, updated_at: nowIso })
        .in("id", group.map((r) => r.id))
        .in("status", ["blocked", "expired"])
        .select("id, phone")
      if (error) {
        failed = true
        console.error("[BLOCKED-ADMIN] direct allow failed:", (error as { code?: string }).code ?? "db")
        continue
      }
      for (const u of (data ?? []) as Array<{ id: string }>) {
        const src = byId.get(u.id)
        if (!src) continue
        updatedIds.push(u.id)
        verified.set(src.phone, true)
      }
    }
  }

  if (verified.size > 0) {
    try {
      await deps.setCache(verified, await deps.getCheckoutProviders())
    } catch {
      console.error("[BLOCKED-ADMIN] verdict cache write failed")
    }
  }
  console.log(`[BLOCKED-ADMIN] direct allow requested=${rows.length} updated=${updatedIds.length} failed=${failed}`)
  return { updatedIds, failed }
}
