/**
 * Real SmsDeps wiring for the v2 SMS routes. CREDITS PATH.
 *
 * - engine: the shared enqueueSendBatched (lib/sms/send-service.ts, unchanged). Only { scheduledFor }
 *   is ever passed as options; v2 never forwards a provider (the tenant default decides).
 * - claims: lib/api-v2/idempotency.ts bound to the service-role client.
 * - the send path uses getOrCreateAccountForUser (v1's own gate); every READ path uses a read-only
 *   lookup of sms_accounts by user_id so a read can never create an account.
 * - campaign reads reuse lib/sms/customer-reads.ts, which scopes every query by the account id.
 */
import { enqueueSendBatched } from "@/lib/sms/send-service"
import { getOrCreateAccountForUser, getPendingUnits, type SmsAccount } from "@/lib/sms/account-service"
import { getShopTokens } from "@/lib/sms/shop-context-service"
import { listRecords, getRecord } from "@/lib/sms/customer-reads"
import { loadDefaultSender } from "@/lib/sms/default-sender"
import { getAdminClient, type SupabaseLike } from "../store"
import { claimRequest, completeClaim, markClaimUnknown, releaseClaim } from "../idempotency"
import type { SmsDeps, SmsEngineParams, SmsCampaignPage, SmsCampaignRecord } from "./sms"

export const SMS_SENDER_COLUMNS = "id, sender_id, local_status, created_at"

/** Read-only: the caller's SMS account or null. Throws on a read error. */
export async function lookupSmsAccount(client: SupabaseLike, userId: string): Promise<SmsAccount | null> {
  const { data, error } = await (client as any).from("sms_accounts").select("*").eq("user_id", userId).maybeSingle()
  if (error) throw new Error("sms account read failed")
  return (data as SmsAccount | null) ?? null
}

/**
 * Mirrors v1's resolution: the requested sender passes through (the engine validates it and answers
 * INVALID_SENDER_ID); otherwise the account's chosen default when it is ACTIVE and the account's own,
 * otherwise its oldest active sender; null when it has none. Throws on a read error.
 */
export async function resolveSmsSender(client: SupabaseLike, account: SmsAccount, requested: string | null): Promise<string | null> {
  if (requested) return requested
  if (account.default_sender_id) {
    const { data, error } = await (client as any)
      .from("sms_sender_ids")
      .select("sender_id")
      .eq("id", account.default_sender_id)
      .eq("sms_account_id", account.id)
      .eq("local_status", "active")
      .maybeSingle()
    if (error) throw new Error("sms sender read failed")
    const id = (data as { sender_id?: string } | null)?.sender_id
    if (typeof id === "string" && id) return id
  }
  return loadDefaultSender(client as any, account.id)
}

/** The account's sender rows (allow-listed columns), oldest first. Throws on a read error. */
export async function fetchSmsSenders(client: SupabaseLike, accountId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await (client as any)
    .from("sms_sender_ids")
    .select(SMS_SENDER_COLUMNS)
    .eq("sms_account_id", accountId)
    .order("created_at", { ascending: true })
  if (error || !Array.isArray(data)) throw new Error("sms senders read failed")
  return data as Record<string, unknown>[]
}

export async function realSmsEngine(p: SmsEngineParams): Promise<unknown> {
  return p.scheduledFor
    ? enqueueSendBatched(p.userId, p.accountId, p.message, p.recipients, p.tokens, p.senderId, { scheduledFor: p.scheduledFor })
    : enqueueSendBatched(p.userId, p.accountId, p.message, p.recipients, p.tokens, p.senderId)
}

/** URGENT admin alert through the same notifier as the AFA alert. Never throws. */
export async function realSmsAlert(message: string): Promise<void> {
  try {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(message, "sms_review", undefined, false)
  } catch {
    // alerting must never break the flow
  }
}

export function realSmsDeps(): SmsDeps {
  const client = getAdminClient()
  return {
    claim: (p) => claimRequest(client, p),
    complete: (claimId, orderRef, response, userId) => completeClaim(client, claimId, orderRef, response, Date.now, userId),
    release: (claimId, userId) => releaseClaim(client, claimId, userId),
    markUnknown: (claimId, userId, orderRef) => markClaimUnknown(client, claimId, userId, orderRef),
    alert: realSmsAlert,
    getOrCreateAccount: (userId) => getOrCreateAccountForUser(userId),
    lookupAccount: (userId) => lookupSmsAccount(client, userId),
    resolveSender: (account, requested) => resolveSmsSender(client, account, requested),
    shopTokens: (account) => getShopTokens(account),
    engine: realSmsEngine,
    listCampaigns: (accountId, i) => listRecords(accountId, i) as Promise<SmsCampaignPage>,
    getCampaign: (accountId, id) => getRecord(accountId, id) as unknown as Promise<SmsCampaignRecord | null>,
    listSenders: (accountId) => fetchSmsSenders(client, accountId),
    pendingUnits: (accountId) => getPendingUnits(accountId),
    now: () => Date.now(),
  }
}
