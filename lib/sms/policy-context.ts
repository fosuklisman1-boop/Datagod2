/**
 * I/O around the pure send policy: loads settings, our own link domains, recent usage and
 * the account's audience, resolves the chosen sender, and produces the record-only shadow.
 * shadowPolicy() never throws — a policy hiccup must not stop a send in Phase 1.
 */
import { createClient } from "@supabase/supabase-js"
import { evaluateSendPolicy, type PolicyResult, type PolicySender, type PolicyUsage } from "./policy"
import { loadSmsSettings, type SmsMode } from "./platform-settings"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const PLATFORM_ROOT_DOMAIN = "datagod.store"

export function audienceFor(ownerType: string, role: string | null | undefined): string {
  if (ownerType === "platform") return "admin"
  if (ownerType === "shop") return "shop_owner"
  if (ownerType === "sub_agent") return "sub_agent"
  return role || "user"
}

export interface PolicyShadow extends PolicyResult { enforced: boolean; evaluated_at: string }
export function buildShadow(r: PolicyResult, enforced: boolean, now = new Date()): PolicyShadow {
  return { ...r, enforced, evaluated_at: now.toISOString() }
}

let domainCache: { at: number; value: string[] } | null = null
/** datagod.store (+ subdomains via isOwnDomain) and every active custom domain. 5-min cache. */
export async function loadOwnDomains(): Promise<string[]> {
  if (domainCache && Date.now() - domainCache.at < 5 * 60_000) return domainCache.value
  const { data } = await supabaseAdmin.from("custom_domains").select("domain").eq("is_active", true)
  const value = [PLATFORM_ROOT_DOMAIN, ...((data ?? []) as { domain: string | null }[]).map((r) => (r.domain ?? "").toLowerCase()).filter(Boolean)]
  domainCache = { at: Date.now(), value }
  return value
}

/** Sends in the last hour and recipients in the last 24 h (blocked sends don't count). */
export async function loadUsage(accountId: string, now = Date.now()): Promise<PolicyUsage> {
  const hourAgo = new Date(now - 3_600_000).toISOString()
  const dayAgo = new Date(now - 86_400_000).toISOString()
  const [hour, day] = await Promise.all([
    supabaseAdmin.from("sms_send_logs").select("id", { count: "exact", head: true })
      .eq("sms_account_id", accountId).neq("status", "blocked").gte("created_at", hourAgo),
    supabaseAdmin.from("sms_send_logs").select("recipients_count")
      .eq("sms_account_id", accountId).neq("status", "blocked").gte("created_at", dayAgo),
  ])
  const recipientsLast24h = ((day.data ?? []) as { recipients_count: number | null }[])
    .reduce((s, r) => s + (r.recipients_count ?? 0), 0)
  return { sendsLastHour: hour.count ?? 0, recipientsLast24h }
}

export interface AccountSnapshot { mode: SmsMode; status: string; ownerType: string; reviewHold: boolean; audience: string }
export async function loadAccountSnapshot(accountId: string): Promise<AccountSnapshot | null> {
  const { data: a } = await supabaseAdmin.from("sms_accounts")
    .select("mode, status, owner_type, review_hold, user_id").eq("id", accountId).maybeSingle()
  if (!a) return null
  const { data: u } = await supabaseAdmin.from("users").select("role").eq("id", a.user_id).maybeSingle()
  return {
    mode: (a.mode as SmsMode) ?? "platform",
    status: a.status,
    ownerType: a.owner_type,
    reviewHold: !!a.review_hold,
    audience: audienceFor(a.owner_type, (u as { role?: string } | null)?.role),
  }
}

/**
 * Resolve a requested sender name for this account. Omitted → platform sender.
 * Own ACTIVE IDs (paused/revoked never resolve), else a pool name for business accounts.
 * Returns null when the name is not usable (→ INVALID_SENDER_ID).
 */
export async function resolveCampaignSender(accountId: string, senderId?: string | null): Promise<PolicySender | null> {
  const sid = (senderId ?? "").trim().toUpperCase()
  if (!sid) return { kind: "platform", name: null, kycFree: false }
  const { data: own } = await supabaseAdmin.from("sms_sender_ids")
    .select("sender_id, kyc_free").eq("sms_account_id", accountId).eq("sender_id", sid)
    .eq("local_status", "active").maybeSingle()
  if (own) return { kind: "own", name: sid, kycFree: !!(own as { kyc_free?: boolean }).kyc_free }
  const [settings, account] = await Promise.all([loadSmsSettings(), loadAccountSnapshot(accountId)])
  if (account?.mode === "business" && settings.senderPool.includes(sid)) return { kind: "pool", name: sid, kycFree: false }
  return null
}

/** Evaluate the policy for a send and return { mode, shadow }. Never throws. */
export async function shadowPolicy(args: {
  accountId: string; sender: PolicySender; recipientCount: number; message: string
}): Promise<{ mode: SmsMode | null; shadow: PolicyShadow | { error: string; evaluated_at: string } }> {
  try {
    const [settings, ownDomains, usage, account] = await Promise.all([
      loadSmsSettings(), loadOwnDomains(), loadUsage(args.accountId), loadAccountSnapshot(args.accountId),
    ])
    if (!account) return { mode: null, shadow: { error: "account not found", evaluated_at: new Date().toISOString() } }
    const r = evaluateSendPolicy({
      account: { audience: account.audience, status: account.status, mode: account.mode, reviewHold: account.reviewHold },
      settings, ownDomains, usage, sender: args.sender, recipientCount: args.recipientCount, message: args.message,
    })
    if (settings.policyEnforced) {
      console.warn("[SMS-POLICY] sms_policy_enforced=true but enforcement ships in Phase 3 — recording only")
    }
    return { mode: account.mode, shadow: buildShadow(r, false) }
  } catch (e) {
    console.error("[SMS-POLICY] shadow evaluation failed:", e)
    return { mode: null, shadow: { error: String((e as Error)?.message ?? e), evaluated_at: new Date().toISOString() } }
  }
}
