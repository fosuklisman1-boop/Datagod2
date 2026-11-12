import type { MomoClaimCtx } from "../contexts"
import { appUrl, emailShell } from "../html"
import type { FlowDef } from "../types"

const ADMIN_URL = "/admin/momo-claims"

const TITLES: Record<MomoClaimCtx["kind"], string> = {
  credited: "MoMo claim credited",
  flagged: "MoMo claim needs review",
  unparsed: "Unreadable MoMo SMS",
  reconciliation_missing: "Claimed payments missing from MoMo statement",
  setting_changed: "Send & Claim setting changed",
}

const REASON_WORDS: Record<string, string> = {
  first_claim: "first claim",
  amount_mismatch: "amount mismatch",
  txid_regression: "old transaction ID",
  balance_repeat: "repeated balance",
  above_max: "above maximum",
  above_review_threshold: "large amount",
  daily_cap: "daily cap reached",
  too_many_attempts: "too many wrong attempts",
}

function ghs(pesewas: number): string {
  return `GHS ${(pesewas / 100).toFixed(2)}`
}

// Only the fields below are ever read from ctx, so a caller passing extra data
// (full txid, payer name, phone, raw SMS) can never leak it into an alert.
function details(c: MomoClaimCtx): string[] {
  const out: string[] = []
  if (typeof c.amountPesewas === "number" && Number.isFinite(c.amountPesewas)) out.push(`Amount: ${ghs(c.amountPesewas)}`)
  const last4 = String(c.txidLast4 ?? "").replace(/\D/g, "").slice(-4)
  if (last4) out.push(`Transaction ID ending ${last4}`)
  const reasons = (c.reasons ?? []).map((r) => REASON_WORDS[r] ?? String(r).replace(/_/g, " "))
  if (reasons.length) out.push(`${c.kind === "setting_changed" ? "Change" : "Reasons"}: ${reasons.join(", ")}`)
  return out
}

export const momoClaimFlow: FlowDef<MomoClaimCtx> = {
  adminAlert(c) {
    const title = TITLES[c.kind]
    const lines = details(c)
    return {
      subject: title,
      html: emailShell({
        heading: title,
        paragraphs: lines.length ? lines : ["Open the MoMo claims page for details."],
        cta: { label: "Open MoMo claims", url: appUrl(ADMIN_URL) },
      }),
      pushTitle: title,
      pushBody: lines.length ? lines.join(". ") : "Open the MoMo claims page for details.",
      url: ADMIN_URL,
    }
  },
  userMessage() {
    return null
  },
}
