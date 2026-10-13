import type { SenderIdCtx } from "../contexts"
import { appUrl, clipSms, emailShell } from "../html"
import type { FlowDef, Outcome, UserMessage } from "../types"

// The SMS platform admin page; its Sender IDs tab is selected via ?tab=sender-ids.
const ADMIN_URL = "/admin/sms?tab=sender-ids"

export const senderIdFlow: FlowDef<SenderIdCtx> = {
  adminAlert(c) {
    return {
      subject: `New SMS sender ID request: ${c.senderId}`,
      html: emailShell({
        heading: "New SMS sender ID request",
        paragraphs: [`The sender ID "${c.senderId}" is waiting for review.`],
        cta: { label: "Review sender IDs", url: appUrl(ADMIN_URL) },
      }),
      pushTitle: "New SMS sender ID request",
      pushBody: c.senderId,
      url: ADMIN_URL,
    }
  },
  userMessage(outcome: Outcome, c): UserMessage | null {
    if (outcome === "approved") {
      const text = `Your SMS sender ID "${c.senderId}" has been approved. You can now send messages with it.`
      return {
        emailSubject: `SMS sender ID approved: ${c.senderId}`,
        emailHtml: emailShell({ heading: "Sender ID approved", paragraphs: [text] }),
        sms: clipSms(text),
      }
    }
    if (outcome === "rejected") {
      const why = c.reason ? [`Reason: ${c.reason}`] : []
      return {
        emailSubject: `SMS sender ID not approved: ${c.senderId}`,
        emailHtml: emailShell({
          heading: "Sender ID not approved",
          paragraphs: [`Your SMS sender ID "${c.senderId}" was not approved.`, ...why, "Please contact support if you need help."],
        }),
        sms: clipSms(`Your SMS sender ID "${c.senderId}" was not approved.${c.reason ? ` Reason: ${c.reason}.` : ""} Contact support.`),
      }
    }
    return null
  },
}
