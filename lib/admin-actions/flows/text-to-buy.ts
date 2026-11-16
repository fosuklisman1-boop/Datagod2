import type { TextToBuyCtx } from "../contexts"
import { appUrl, emailShell } from "../html"
import type { FlowDef } from "../types"

const ADMIN_URL = "/admin/text-to-buy"
const TITLE = "Text-to-Buy setting changed"

// Only ctx.keys is ever read, and only as setting names (never values or numbers), so a caller passing extra data cannot leak it.
function details(c: TextToBuyCtx): string[] {
  const keys = (Array.isArray(c.keys) ? c.keys : []).map((k) => String(k).replace(/^ttb_/, "").replace(/_/g, " ")).filter(Boolean)
  return keys.length ? [`Changed: ${keys.join(", ")}`] : []
}

export const textToBuyFlow: FlowDef<TextToBuyCtx> = {
  adminAlert(c) {
    const lines = details(c)
    return {
      subject: TITLE,
      html: emailShell({
        heading: TITLE,
        paragraphs: lines.length ? lines : ["Open the Text-to-Buy page for details."],
        cta: { label: "Open Text-to-Buy", url: appUrl(ADMIN_URL) },
      }),
      pushTitle: TITLE,
      pushBody: lines.length ? lines.join(". ") : "Open the Text-to-Buy page for details.",
      url: ADMIN_URL,
    }
  },
  userMessage() {
    return null
  },
}
