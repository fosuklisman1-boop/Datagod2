import type { ShopCtx } from "../contexts"
import { appUrl, clipSms, emailShell } from "../html"
import type { FlowDef, Outcome, UserMessage } from "../types"

// Matches the existing approve/reject routes (action_url), not the withdrawal dashboard.
const OWNER_URL = "/dashboard/my-shop"

export const shopFlow: FlowDef<ShopCtx> = {
  adminAlert(c) {
    return {
      subject: `New shop awaiting approval: ${c.shopName}`,
      html: emailShell({
        heading: "New shop awaiting approval",
        paragraphs: [`The shop "${c.shopName}" has been submitted and is waiting for approval.`],
        cta: { label: "Review shops", url: appUrl("/admin/shops") },
      }),
      pushTitle: "New shop awaiting approval",
      pushBody: c.shopName,
      url: "/admin/shops",
    }
  },
  userMessage(outcome: Outcome, c): UserMessage | null {
    if (outcome === "approved") {
      const msg = `Congratulations! Your shop "${c.shopName}" has been approved and is now active.`
      return {
        emailSubject: "Shop Approved!",
        emailHtml: emailShell({
          heading: "Shop approved",
          paragraphs: [
            `Your shop "${c.shopName}" is now live.`,
            ...(c.ownerPhone ? [`Contact number: ${c.ownerPhone}`] : []),
            "You can now start selling data bundles and managing your shop from your dashboard.",
          ],
          cta: { label: "Manage shop", url: appUrl(OWNER_URL) },
        }),
        sms: clipSms("DTGOD: Congratulations! Your shop has been approved. You can now start selling. Visit: www.datagod.store"),
        push: { title: "Shop Approved", body: msg, url: OWNER_URL },
        inApp: { title: "Shop Approved", message: msg, type: "admin_action", actionUrl: OWNER_URL },
      }
    }
    if (outcome === "rejected") {
      const msg = `Your shop "${c.shopName}" has been rejected. ${c.reason ? `Reason: ${c.reason}` : "Please contact support for more information."}`
      return {
        emailSubject: "Shop Application Update",
        emailHtml: emailShell({
          heading: "Application status update",
          paragraphs: [
            `Your shop application for "${c.shopName}" was not approved.`,
            ...(c.ownerPhone ? [`Contact number: ${c.ownerPhone}`] : []),
            ...(c.reason ? [`Reason: ${c.reason}`] : []),
            "If you have questions about this decision, please contact our support team.",
          ],
          cta: { label: "Back to dashboard", url: appUrl("/dashboard") },
        }),
        sms: clipSms(`Your shop "${c.shopName}" has been rejected.${c.reason ? ` Reason: ${c.reason}` : ""} Contact support for more details.`),
        push: { title: "Shop Rejected", body: msg, url: OWNER_URL },
        inApp: { title: "Shop Rejected", message: msg, type: "admin_action", actionUrl: OWNER_URL },
      }
    }
    return null
  },
}
