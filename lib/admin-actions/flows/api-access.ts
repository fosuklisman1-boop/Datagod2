import type { ApiAccessCtx } from "../contexts"
import { appUrl, clipSms, emailShell } from "../html"
import type { FlowDef, Outcome, UserMessage } from "../types"

// Admin inbox (Task 9 selects the Approvals tab from ?tab=approvals) and the developer page.
const ADMIN_URL = "/admin/api-keys?tab=approvals"
const OWNER_URL = "/dashboard/developer"
const HIJACK = "If this wasn't you, change your password and contact support."

const TYPE_LABEL: Record<NonNullable<ApiAccessCtx["keyType"]>, string> = {
  standard: "Standard",
  commission: "Commission Services",
  sms: "SMS",
}

/** "live Standard key", "replacement live key", or "API access". Never a key or key prefix. */
function what(c: ApiAccessCtx): string {
  if (c.kind === "access") return "API access"
  const t = c.keyType ? `${TYPE_LABEL[c.keyType]} ` : ""
  return c.kind === "swap" ? `replacement live ${t}key` : `live ${t}key`
}

const codeText = (c: ApiAccessCtx) => (c.code ? ` (code ${c.code})` : "")

export const apiAccessFlow: FlowDef<ApiAccessCtx> = {
  adminAlert(c) {
    const subject =
      c.kind === "access"
        ? `New API access request${codeText(c)}`
        : c.kind === "swap"
          ? `New API key replacement request${codeText(c)}`
          : `New live API key request${codeText(c)}`
    const who = c.who ? `${c.who} has requested ${what(c)}.` : `Someone has requested ${what(c)}.`
    return {
      subject,
      html: emailShell({
        heading: subject,
        paragraphs: [who, "Before approving, match the request code and check the WhatsApp sender is the account's registered phone."],
        cta: { label: "Review API approvals", url: appUrl(ADMIN_URL) },
      }),
      pushTitle: "New API approval request",
      pushBody: c.code ?? what(c),
      url: ADMIN_URL,
    }
  },

  userMessage(outcome: Outcome, c): UserMessage | null {
    const inApp = (title: string, message: string) => ({ title, message, type: "admin_action", actionUrl: OWNER_URL })
    const push = (title: string, body: string) => ({ title, body, url: OWNER_URL })
    const cta = { label: "Open Developer API", url: appUrl(OWNER_URL) }

    if (outcome === "requested") {
      const text = `A request for ${what(c)}${codeText(c)} was made on your Datagod account. ${HIJACK}`
      return {
        emailSubject: `Datagod API request${codeText(c)}`,
        emailHtml: emailShell({ heading: "API request received", paragraphs: [text], cta }),
        inApp: inApp("API request received", text),
      }
    }

    if (outcome === "approved") {
      const text =
        c.kind === "access"
          ? "Your Datagod API access has been approved. You can now create API keys."
          : c.kind === "swap"
            ? `Your ${what(c)} has been approved and is now active. Your old key has stopped working.`
            : `Your ${what(c)} has been approved and is now active.`
      return {
        emailSubject: c.kind === "access" ? "Datagod API access approved" : "Datagod API key approved",
        emailHtml: emailShell({ heading: "Approved", paragraphs: [text], cta }),
        sms: clipSms(`Datagod: ${text}`),
        push: push("API request approved", text),
        inApp: inApp("API request approved", text),
      }
    }

    if (outcome === "rejected") {
      const base = `Your request for ${what(c)}${codeText(c)} was not approved.`
      const text = c.reason ? `${base} Reason: ${c.reason}` : base
      return {
        emailSubject: "Datagod API request not approved",
        emailHtml: emailShell({
          heading: "Request not approved",
          paragraphs: [base, ...(c.reason ? [`Reason: ${c.reason}`] : []), "You can request again from the Developer API page."],
          cta,
        }),
        sms: clipSms(`Datagod: ${text}`),
        push: push("API request not approved", text),
        inApp: inApp("API request not approved", text),
      }
    }

    if (outcome === "removed") {
      const text = `Your Datagod API access has been removed.${c.reason ? ` Reason: ${c.reason}` : ""} Contact support if you have questions.`
      return {
        emailSubject: "Datagod API access removed",
        emailHtml: emailShell({ heading: "API access removed", paragraphs: [text] }),
        inApp: inApp("API access removed", text),
      }
    }

    return null
  },
}
