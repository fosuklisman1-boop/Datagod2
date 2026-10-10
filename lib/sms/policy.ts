/**
 * Send policy (spec §5.3). Pure: the caller supplies account, settings, usage, sender and
 * message; nothing here does I/O. Checks run in a fixed order and the first failure wins,
 * so the customer always gets the single most relevant message. In Phase 1 the result is
 * only RECORDED (sms_send_logs.policy_shadow); enforcement arrives with Phase 3.
 */
import { extractLinkHosts, matchBlockedContent, suspiciousHostReason } from "./content-filter"
import type { SmsMode, SmsPlatformSettings } from "./platform-settings"

export type PolicyDecision = "allow" | "hold" | "reject" | "block" | "unavailable"
export type PolicyCode =
  | "OK" | "FEATURE_DISABLED" | "ROLE_NOT_ALLOWED" | "SUSPENDED" | "SENDER_NOT_ALLOWED"
  | "CAP_PER_SEND" | "CAP_PER_HOUR" | "CAP_PER_DAY" | "CONTENT_BLOCKED" | "LINK_NOT_ALLOWED" | "REVIEW_HOLD"

export interface PolicyFlag { severity: "fraud" | "info"; reason: string; matched: string }
export interface PolicyAccount {
  /** "admin" for platform owner accounts; otherwise shop_owner | sub_agent | dealer | user */
  audience: string
  status: string
  mode: SmsMode
  reviewHold: boolean
}
export interface PolicySender { kind: "platform" | "own" | "pool"; name: string | null; kycFree: boolean }
export interface PolicyUsage { sendsLastHour: number; recipientsLast24h: number }

export interface PolicyInput {
  account: PolicyAccount
  settings: SmsPlatformSettings
  ownDomains: string[]
  usage: PolicyUsage
  sender: PolicySender
  recipientCount: number
  message: string
}
export interface PolicyResult { decision: PolicyDecision; code: PolicyCode; reason: string; flags: PolicyFlag[] }

const result = (decision: PolicyDecision, code: PolicyCode, reason: string, flags: PolicyFlag[] = []): PolicyResult =>
  ({ decision, code, reason, flags })

export function isOwnDomain(host: string, ownDomains: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "")
  return ownDomains.some((raw) => {
    const d = raw.toLowerCase().replace(/^www\./, "")
    return !!d && (h === d || h.endsWith(`.${d}`))
  })
}

const keywordOf = (reason: string) => /^blocked keyword: "(.*)"$/.exec(reason)?.[1] ?? reason
const fmt = (n: number) => n.toLocaleString("en-US")

export function evaluateSendPolicy(p: PolicyInput): PolicyResult {
  const { account, settings, usage, sender } = p

  // 1. Master switch
  if (!settings.featureEnabled) {
    return result("unavailable", "FEATURE_DISABLED", "SMS sending is temporarily unavailable. Please try again later.")
  }

  // 2. Role + account status
  if (account.audience !== "admin" && !settings.allowedRoles.includes(account.audience)) {
    return result("reject", "ROLE_NOT_ALLOWED", "SMS isn't available for your account type. Contact support if you need it.")
  }
  if (account.status === "suspended") {
    return result("reject", "SUSPENDED", "Your SMS account is suspended. Contact support to restore it.")
  }

  // 3. Sender allowed for mode
  if (account.mode === "platform") {
    if (sender.kind === "pool") {
      return result("reject", "SENDER_NOT_ALLOWED", "Shared sender names are for verified businesses. Use the platform sender or your own sender ID.")
    }
    if (sender.kind === "own" && !sender.kycFree) {
      return result("reject", "SENDER_NOT_ALLOWED", `In Platform mode you can send as the platform sender or your one free sender ID. Verify your business to use ${sender.name ?? "this sender ID"}.`)
    }
  }

  // 4. Caps (this send counts toward the hour and the day)
  const cap = settings.caps[account.mode]
  if (p.recipientCount > cap.per_send) {
    return result("reject", "CAP_PER_SEND", `This send has ${fmt(p.recipientCount)} recipients; your limit is ${fmt(cap.per_send)} per send. Split it into smaller sends.`)
  }
  if (usage.sendsLastHour + 1 > cap.per_hour) {
    return result("reject", "CAP_PER_HOUR", `You've reached ${fmt(cap.per_hour)} sends this hour. Try again within the hour.`)
  }
  if (usage.recipientsLast24h + p.recipientCount > cap.per_day) {
    return result("reject", "CAP_PER_DAY", `This would pass your daily limit of ${fmt(cap.per_day)} recipients (${fmt(usage.recipientsLast24h)} used in the last 24 hours). Reduce recipients or try again later.`)
  }

  // 5. Content
  const flags: PolicyFlag[] = []
  const hosts = extractLinkHosts(p.message)
  if (account.mode === "platform") {
    const blocked = matchBlockedContent(p.message, settings.blockedKeywords)
    if (blocked) {
      return result("block", "CONTENT_BLOCKED", "This message contains content we can't send. Edit it and try again.",
        [{ severity: "fraud", reason: blocked, matched: keywordOf(blocked) }])
    }
    // Own domains are exempt (shop slugs may contain digits, which the lookalike check would
    // flag as fraud). Scan ALL foreign hosts for fraud signals before reporting a plain
    // disallowed link, so "example.com or bit.ly/x" cannot hide the shortener behind an earlier host.
    const foreign = hosts.filter((h) => !isOwnDomain(h, p.ownDomains))
    for (const host of foreign) {
      const suspicious = suspiciousHostReason(host)
      if (suspicious) {
        return result("block", "CONTENT_BLOCKED", `The link ${host} isn't allowed. Remove it and try again.`,
          [{ severity: "fraud", reason: suspicious, matched: host }])
      }
    }
    if (foreign.length > 0) {
      return result("block", "LINK_NOT_ALLOWED", `Platform mode only allows links to your Datagod store. Remove ${foreign[0]}, or verify your business to send other links.`)
    }
  } else {
    const blocked = matchBlockedContent(p.message, settings.businessBlockedKeywords)
    if (blocked) {
      return result("block", "CONTENT_BLOCKED", "This message contains content we can't send. Edit it and try again.",
        [{ severity: "fraud", reason: blocked, matched: keywordOf(blocked) }])
    }
    const lower = p.message.toLowerCase()
    const seenKw = new Set<string>()
    for (const kw of settings.businessFlaggedKeywords) {
      const k = kw.trim().toLowerCase()
      if (k && !seenKw.has(k) && lower.includes(k)) {
        seenKw.add(k)
        flags.push({ severity: "info", reason: `flagged keyword: "${kw}"`, matched: kw })
      }
    }
    for (const host of hosts) {
      const suspicious = suspiciousHostReason(host)
      if (suspicious && !isOwnDomain(host, [...p.ownDomains, ...settings.businessAllowedDomains])) {
        flags.push({ severity: "info", reason: suspicious, matched: host })
      }
    }
  }

  // 6. Review hold: everything passed, but an admin must release it.
  if (account.reviewHold) {
    return result("hold", "REVIEW_HOLD", "Your account is under review. This send will go out once an admin approves it.", flags)
  }
  return result("allow", "OK", "", flags)
}
