import type { ResultsCheckCtx } from "../contexts"
import { appUrl, clipSms, emailShell } from "../html"
import type { FlowDef, Outcome, UserMessage } from "../types"

const CHANNEL_LABELS: Record<string, string> = { whatsapp: "WhatsApp", whatsapp_shop: "WhatsApp Shop", web: "Web", ussd: "USSD" }
/** Friendly channel name for admin-facing text only (the user hint keeps the raw channel). */
const channelLabel = (ch?: string | null) => (ch ? CHANNEL_LABELS[ch] ?? ch : "")

function hintFor(channel?: string | null): string {
  if (channel === "whatsapp" || channel === "whatsapp_shop") return "Check your WhatsApp for the result."
  if (channel === "web") return "Check your email or dashboard for the result."
  return ""
}

export const resultsCheckFlow: FlowDef<ResultsCheckCtx> = {
  adminAlert(c) {
    const extra = [channelLabel(c.channel), c.shopName].filter(Boolean).join(" · ")
    return {
      subject: `New results check request: ${c.examBoard}`,
      html: emailShell({
        heading: "New results check request",
        paragraphs: [
          `A ${c.examBoard} results check (index ${c.indexNumber}) is waiting to be processed.`,
          ...(c.examYear ? [`Exam year: ${c.examYear}`] : []),
          ...(c.channel ? [`Channel: ${channelLabel(c.channel)}`] : []),
          ...(c.shopName ? [`Shop: ${c.shopName}`] : []),
        ],
        cta: { label: "Review requests", url: appUrl("/admin/results-check-requests") },
      }),
      pushTitle: "New results check request",
      pushBody: `${c.examBoard} · index ${c.indexNumber}${extra ? ` · ${extra}` : ""}`,
      url: "/admin/results-check-requests",
    }
  },
  userMessage(outcome: Outcome, c): UserMessage | null {
    if (outcome === "completed") {
      const done = `Your ${c.examBoard} results check (index ${c.indexNumber}) has been completed.`
      const hint = hintFor(c.channel)
      const text = hint ? `${done} ${hint}` : done
      return {
        emailSubject: `Your ${c.examBoard} results check is complete`,
        emailHtml: emailShell({ heading: "Results check completed", paragraphs: [text] }),
        sms: clipSms(text),
      }
    }
    if (outcome === "rejected") {
      const why = c.reason ? [`Reason: ${c.reason}`] : []
      return {
        emailSubject: `Your ${c.examBoard} results check could not be completed`,
        emailHtml: emailShell({
          heading: "Results check not completed",
          paragraphs: [`Your ${c.examBoard} results check (index ${c.indexNumber}) could not be completed.`, ...why, "Please contact support if you need help."],
        }),
        sms: clipSms(`Your ${c.examBoard} results check (index ${c.indexNumber}) could not be completed.${c.reason ? ` Reason: ${c.reason}.` : ""} Contact support.`),
      }
    }
    return null
  },
}
