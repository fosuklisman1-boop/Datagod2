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
  const { data, error } = await supabaseAdmin.from("custom_domains").select("domain").eq("is_active", true)
  if (error) throw new Error(`custom_domains read failed: ${error.message}`) // never cache a failed read
  const value = [PLATFORM_ROOT_DOMAIN, ...((data ?? []) as { domain: string | null }[]).map((r) => (r.domain ?? "").toLowerCase()).filter(Boolean)]
  domainCache = { at: Date.now(), value }
  return value
}

/** Sends in the last hour and recipients in the last 24 h (blocked sends don't count). */
export async function loadUsage(accountId: string): Promise<PolicyUsage> {
  const { data, error } = await supabaseAdmin.rpc("sms_account_usage", { p_account_id: accountId })
  if (error) throw new Error(`sms_account_usage failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as
    { sends_last_hour?: number | string | null; recipients_last_24h?: number | string | null } | null | undefined
  return {
    sendsLastHour: Number(row?.sends_last_hour ?? 0),
    recipientsLast24h: Number(row?.recipients_last_24h ?? 0), // bigint may arrive as a string
  }
}

export interface AccountSnapshot { mode: SmsMode; status: string; ownerType: string; reviewHold: boolean; audience: string }
export async function loadAccountSnapshot(accountId: string): Promise<AccountSnapshot | null> {
  const { data: a, error } = await supabaseAdmin.from("sms_accounts")
    .select("mode, status, owner_type, review_hold, user_id").eq("id", accountId).maybeSingle()
  if (error) throw new Error(`sms_accounts read failed: ${error.message}`)
  if (!a) return null
  const { data: u, error: uErr } = await supabaseAdmin.from("users").select("role").eq("id", a.user_id).maybeSingle()
  if (uErr) throw new Error(`users read failed: ${uErr.message}`)
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
  const { data: own, error: ownErr } = await supabaseAdmin.from("sms_sender_ids")
    .select("sender_id, kyc_free").eq("sms_account_id", accountId).eq("sender_id", sid)
    .eq("local_status", "active").maybeSingle()
  // A transient read error is treated as "not found" (as before) but logged.
  if (ownErr) console.error("[SMS-POLICY] own sender lookup failed:", ownErr.message)
  if (own) return { kind: "own", name: sid, kycFree: !!(own as { kyc_free?: boolean }).kyc_free }
  try {
    const [settings, account] = await Promise.all([loadSmsSettings(), loadAccountSnapshot(accountId)])
    if (account?.mode === "business" && settings.senderPool.includes(sid)) return { kind: "pool", name: sid, kycFree: false }
  } catch (e) {
    // No new throw path before the debit: behave as before (unresolvable → INVALID_SENDER_ID).
    console.error("[SMS-POLICY] pool sender lookup failed:", e)
  }
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

export const SHADOW_TIMEOUT_MS = 1500

/** shadowPolicy raced against a deadline, so a slow policy read can't delay a send. Never throws. */
export async function shadowPolicyWithin(
  args: Parameters<typeof shadowPolicy>[0],
  ms = SHADOW_TIMEOUT_MS,
): ReturnType<typeof shadowPolicy> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Awaited<ReturnType<typeof shadowPolicy>>>((resolve) => {
    timer = setTimeout(
      () => resolve({ mode: null, shadow: { error: "timeout", evaluated_at: new Date().toISOString() } }),
      ms,
    )
  })
  try {
    return await Promise.race([shadowPolicy(args), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
