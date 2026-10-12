import type { WithdrawalCtx } from "../contexts"
import { appUrl, clipSms, emailShell, maskNumber } from "../html"
import type { FlowDef, Outcome, UserMessage } from "../types"

const money = (n: number) => `GHS ${(Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2)}`
const OWNER_URL = "/dashboard/shop-dashboard"
const ref = (c: WithdrawalCtx) => (c.withdrawalId ? [`Reference: ${c.withdrawalId}`] : [])
const details = (c: WithdrawalCtx) =>
  [c.method ? `Method: ${c.method}` : "", c.phone ? `To: ${maskNumber(c.phone)}` : ""].filter(Boolean)

export const withdrawalFlow: FlowDef<WithdrawalCtx> = {
  adminAlert(c) {
    const from = c.shopName ? ` from ${c.shopName}` : ""
    return {
      subject: `New withdrawal request: ${money(c.amount)}`,
      html: emailShell({
        heading: "New withdrawal request",
        paragraphs: [`A withdrawal request of ${money(c.amount)}${from} is waiting for approval.`, ...details(c)],
        cta: { label: "Review withdrawals", url: appUrl("/admin/withdrawals") },
      }),
      pushTitle: "New withdrawal request",
      pushBody: `${money(c.amount)}${from}`,
      url: "/admin/withdrawals",
    }
  },
  userMessage(outcome: Outcome, c): UserMessage | null {
    const bal = c.remainingBalance ? [`Remaining balance: GHS ${c.remainingBalance}`] : []
    if (outcome === "approved") {
      return {
        emailSubject: `Withdrawal approved: ${money(c.amount)}`,
        emailHtml: emailShell({
          heading: "Withdrawal approved",
          paragraphs: [
            `Your withdrawal request of ${money(c.amount)} has been approved and is being processed.`,
            ...ref(c),
            ...details(c),
            ...bal,
            "The funds should arrive in your account within 24 hours.",
          ],
          cta: { label: "Open dashboard", url: appUrl(OWNER_URL) },
        }),
        sms: clipSms(`Your withdrawal of ${money(c.amount)} has been approved and is being processed.`),
        push: { title: "Withdrawal approved", body: `Your withdrawal request for ${money(c.amount)} has been approved.`, url: OWNER_URL },
        inApp: { title: "Withdrawal approved", message: `Your withdrawal request for ${money(c.amount)} has been approved.`, type: "withdrawal_approved", actionUrl: OWNER_URL },
      }
    }
    if (outcome === "rejected") {
      const why = c.reason ? [`Reason: ${c.reason}`] : []
      return {
        emailSubject: `Withdrawal rejected: ${money(c.amount)}`,
        emailHtml: emailShell({
          heading: "Withdrawal not approved",
          paragraphs: [
            `Your withdrawal request of ${money(c.amount)} could not be processed.`,
            ...why,
            ...bal,
            "Your balance remains unchanged. If you have questions, please contact support.",
          ],
          cta: { label: "Open dashboard", url: appUrl(OWNER_URL) },
        }),
        sms: clipSms(`Your withdrawal request of ${money(c.amount)} has been rejected.${c.reason ? ` Reason: ${c.reason}.` : ""} Contact support for assistance.`),
        push: { title: "Withdrawal rejected", body: `Your withdrawal request has been rejected.${c.reason ? ` Reason: ${c.reason}` : ""}`, url: OWNER_URL },
        inApp: { title: "Withdrawal rejected", message: `Your withdrawal request has been rejected.${c.reason ? ` Reason: ${c.reason}` : ""}`, type: "withdrawal_rejected", actionUrl: OWNER_URL },
      }
    }
    if (outcome === "completed") {
      return {
        emailSubject: `Withdrawal paid out: ${money(c.amount)}`,
        emailHtml: emailShell({
          heading: "Withdrawal paid out",
          paragraphs: [`Your withdrawal of ${money(c.amount)} has been paid out.`, ...ref(c), ...details(c), ...bal],
          cta: { label: "Open dashboard", url: appUrl(OWNER_URL) },
        }),
        sms: clipSms(`Your withdrawal of ${money(c.amount)} has been transferred${c.phone ? ` to ${maskNumber(c.phone)}` : " to your account"}.`),
        push: { title: "Withdrawal paid out", body: `Your withdrawal of ${money(c.amount)} has been paid out.`, url: OWNER_URL },
        inApp: { title: "Withdrawal paid out", message: `Your withdrawal of ${money(c.amount)} has been paid out.`, type: "balance_updated", actionUrl: OWNER_URL },
      }
    }
    return null
  },
}
