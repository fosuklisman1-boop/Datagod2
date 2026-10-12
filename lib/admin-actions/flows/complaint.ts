import type { ComplaintCtx } from "../contexts"
import { appUrl, clipSms, emailShell } from "../html"
import type { FlowDef, Outcome, UserMessage } from "../types"

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 3).trimEnd() + "...")

export const complaintFlow: FlowDef<ComplaintCtx> = {
  adminAlert(c) {
    const title = c.priority ? `New ${c.priority} complaint` : "New complaint"
    const summary = c.summary ? clip(c.summary, 80) : ""
    return {
      subject: title,
      html: emailShell({
        heading: title,
        paragraphs: [
          summary || "A new complaint is waiting for review.",
          ...(c.orderId ? [`Order: ${c.orderId}`] : []),
        ],
        cta: { label: "Review complaints", url: appUrl("/admin/complaints") },
      }),
      pushTitle: title,
      pushBody: summary || "A new complaint needs review",
      url: "/admin/complaints",
    }
  },
  userMessage(outcome: Outcome, c): UserMessage | null {
    const notes = c.resolutionNotes ? clip(c.resolutionNotes, 80) : ""
    if (outcome === "resolved") {
      return {
        emailSubject: "Your complaint has been resolved",
        emailHtml: emailShell({
          heading: "Complaint resolved",
          paragraphs: ["Your complaint has been resolved.", ...(c.resolutionNotes ? [`Resolution: ${c.resolutionNotes}`] : [])],
        }),
        sms: clipSms(`Your complaint has been resolved.${notes ? ` ${notes}` : ""}`),
      }
    }
    if (outcome === "rejected") {
      return {
        emailSubject: "Your complaint has been closed",
        emailHtml: emailShell({
          heading: "Complaint closed",
          paragraphs: [
            "Your complaint has been closed without action.",
            ...(c.resolutionNotes ? [`Notes: ${c.resolutionNotes}`] : []),
            "Please contact support if you need more help.",
          ],
        }),
        sms: clipSms(`Your complaint has been closed without action.${notes ? ` ${notes}` : " Contact support if you need help."}`),
      }
    }
    return null
  },
}
