/** Admin overview (Phase 2 spec §4.1): stat cards, tab counts, supply snapshot, policy preview. */
import { createClient } from "@supabase/supabase-js"
import { getWholesaleSnapshot, type WholesaleSnapshot } from "./wholesale"
import { loadSmsSettings } from "./platform-settings"
import { getRoutingConfig } from "./routing"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

/** Row returned by sms_admin_overview(); numerics may arrive as strings. */
export interface OverviewRow {
  revenue_bundles_ghs: string | number
  revenue_activations_ghs: string | number
  credits_sold: string | number
  purchases: string | number
  unrecorded_purchases: string | number
  unrecorded_credits: string | number
  pending_reviews: string | number
  pending_senders: string | number
  fraud_flags: string | number
  info_flags: string | number
}
export interface PreviewRow { decision: string; code: string; n: string | number }

export interface Overview {
  stats: {
    recordedRevenueGhs: number; bundleRevenueGhs: number; activationRevenueGhs: number
    creditsSold: number; purchases: number; pendingReviews: number; pendingSenders: number; fraudFlags: number
  }
  tabCounts: { businessReviews: number; senderIds: number; flagged: number }
  unrecorded: { purchases: number; credits: number }
  supply: WholesaleSnapshot
  featureEnabled: boolean
  policyEnforced: boolean
  provider: string
  policyPreview: { decision: string; code: string; count: number }[]
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const money = (v: unknown) => Math.round(num(v) * 100) / 100

export function composeOverview(
  row: OverviewRow | null,
  preview: PreviewRow[],
  supply: WholesaleSnapshot,
  ctx: { featureEnabled: boolean; policyEnforced: boolean; provider: string }
): Overview {
  const bundles = money(row?.revenue_bundles_ghs)
  const activations = money(row?.revenue_activations_ghs)
  const fraud = num(row?.fraud_flags)
  return {
    stats: {
      recordedRevenueGhs: money(bundles + activations),
      bundleRevenueGhs: bundles,
      activationRevenueGhs: activations,
      creditsSold: num(row?.credits_sold),
      purchases: num(row?.purchases),
      pendingReviews: num(row?.pending_reviews),
      pendingSenders: num(row?.pending_senders),
      fraudFlags: fraud,
    },
    tabCounts: {
      businessReviews: num(row?.pending_reviews),
      senderIds: num(row?.pending_senders),
      flagged: fraud + num(row?.info_flags),
    },
    unrecorded: { purchases: num(row?.unrecorded_purchases), credits: num(row?.unrecorded_credits) },
    supply,
    featureEnabled: ctx.featureEnabled,
    policyEnforced: ctx.policyEnforced,
    provider: ctx.provider,
    policyPreview: preview.map((p) => ({ decision: p.decision, code: p.code, count: num(p.n) })),
  }
}

export async function getOverview(): Promise<Overview> {
  const [overview, preview, supply, settings, routing] = await Promise.all([
    supabaseAdmin.rpc("sms_admin_overview"),
    supabaseAdmin.rpc("sms_policy_preview", { p_days: 7 }),
    getWholesaleSnapshot(),
    loadSmsSettings(),
    getRoutingConfig(),
  ])
  if (overview.error) throw new Error(`overview failed: ${overview.error.message}`)
  if (preview.error) console.error("[SMS-ADMIN] policy preview failed:", preview.error.message)
  return composeOverview(
    ((overview.data as OverviewRow[] | null) ?? [])[0] ?? null,
    (preview.data as PreviewRow[] | null) ?? [],
    supply,
    { featureEnabled: settings.featureEnabled, policyEnforced: settings.policyEnforced, provider: String(routing.primary) }
  )
}
