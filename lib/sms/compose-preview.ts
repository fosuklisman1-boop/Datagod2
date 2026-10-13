/**
 * Draft policy preview for the Compose page: what would the send policy say about this draft?
 * Composes the same helpers shadowPolicy uses (policy-context loaders + evaluateSendPolicy) with
 * the same inputs, but is read-only (no policy_shadow, no flags, no log) and advisory: it never
 * throws, and falls back to `{decision:"allow", unavailable:true}` if anything fails.
 */
import { evaluateSendPolicy, type PolicyCode, type PolicyDecision } from "./policy"
import { loadAccountSnapshot, loadOwnDomains, loadUsage, resolveCampaignSender } from "./policy-context"
import { loadSmsSettings } from "./platform-settings"
import { prepareSmsMessage, type ShopTokens } from "./prepare"

export interface DraftPreview {
  decision: PolicyDecision
  code: PolicyCode
  reason: string
  /** True when content tripped a flag. Flag details are never returned (they would leak admin keyword lists). */
  flagged: boolean
  /** True when the evaluation could not run; the decision is then a non-binding "allow". */
  unavailable?: true
}

const UNAVAILABLE = (reason: string): DraftPreview => ({ decision: "allow", code: "OK", reason, flagged: false, unavailable: true })

export async function previewDraft(args: {
  accountId: string
  message: string
  senderId?: string | null
  recipientCount: number
  tokens: ShopTokens
}): Promise<DraftPreview> {
  try {
    const sender = await resolveCampaignSender(args.accountId, args.senderId)
    if (!sender) {
      return { decision: "reject", code: "SENDER_NOT_ALLOWED", reason: "That sender ID isn't available on your account.", flagged: false }
    }
    let prepared: string
    try {
      prepared = prepareSmsMessage(args.message, args.tokens)
    } catch {
      return UNAVAILABLE("Message is empty once unsupported characters are removed.")
    }
    const [settings, ownDomains, usage, account] = await Promise.all([
      loadSmsSettings(), loadOwnDomains(), loadUsage(args.accountId), loadAccountSnapshot(args.accountId),
    ])
    if (!account) return UNAVAILABLE("Account not found.")
    const r = evaluateSendPolicy({
      account: { audience: account.audience, status: account.status, mode: account.mode, reviewHold: account.reviewHold },
      settings, ownDomains, usage, sender, recipientCount: args.recipientCount, message: prepared,
    })
    return { decision: r.decision, code: r.code, reason: r.reason, flagged: r.flags.length > 0 }
  } catch (e) {
    console.error("[SMS-PREVIEW] draft preview failed:", e)
    return UNAVAILABLE("Preview unavailable.")
  }
}
