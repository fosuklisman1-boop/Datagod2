import type { AfaCtx } from "../contexts"
import { appUrl, clipSms, emailShell } from "../html"
import type { FlowDef, Outcome, UserMessage } from "../types"

export const afaFlow: FlowDef<AfaCtx> = {
  adminAlert(c) {
    return {
      subject: `New AFA registration: ${c.orderCode}`,
      html: emailShell({
        heading: "New AFA registration",
        paragraphs: [`${c.fullName} has submitted an AFA registration (${c.orderCode}) that is waiting for processing.`],
        cta: { label: "Review AFA registrations", url: appUrl("/admin/afa-registrations") },
      }),
      pushTitle: "New AFA registration",
      pushBody: `${c.fullName} (${c.orderCode})`,
      url: "/admin/afa-registrations",
    }
  },
  userMessage(outcome: Outcome, c): UserMessage | null {
    if (outcome === "completed") {
      return {
        emailSubject: `AFA registration complete: ${c.orderCode}`,
        emailHtml: emailShell({
          heading: "AFA registration complete",
          paragraphs: [`AFA registration ${c.orderCode} for ${c.fullName} is complete.`],
        }),
        sms: clipSms(`AFA registration ${c.orderCode} for ${c.fullName} is complete.`),
      }
    }
    if (outcome === "rejected") {
      const why = c.reason ? [`Reason: ${c.reason}`] : []
      return {
        emailSubject: `AFA registration cancelled: ${c.orderCode}`,
        emailHtml: emailShell({
          heading: "AFA registration cancelled",
          paragraphs: [`AFA registration ${c.orderCode} for ${c.fullName} has been cancelled.`, ...why, "Please contact support if you need help."],
        }),
        sms: clipSms(`AFA registration ${c.orderCode} for ${c.fullName} has been cancelled.${c.reason ? ` Reason: ${c.reason}.` : ""} Contact support for help.`),
      }
    }
    return null
  },
}
