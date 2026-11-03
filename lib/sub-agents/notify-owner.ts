import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"
import { sendPushToUser } from "@/lib/push-service"
import { subAgentCosts } from "@/lib/shop-commerce/pricing"
import { cleanDisplayName } from "@/lib/sub-agents/display-name"

// Loosely typed: callers pass the service-role supabase client.
type Db = any

const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "https://datagod.store"
}

/** True when the owner has at least one active catalog row for an available package. A failed read counts as "none":
 *  the worst case is an SMS/email the 24h throttle already caps at one each per owner per day. */
async function ownerHasCatalogPrices(db: Db, parentShopId: string): Promise<boolean> {
  try {
    const { costs } = await subAgentCosts(parentShopId, null, db)
    return [...costs.values()].some((o) => o !== null)
  } catch {
    return false
  }
}

/** Atomically claims a 24h slot on a user_shops timestamp column. True only for the single caller whose UPDATE
 *  returned a row. */
async function claimSlot(
  db: Db,
  shopId: string,
  column: "sub_agent_setup_alert_at" | "sub_agent_prices_ready_notified_at"
): Promise<boolean> {
  const cutoff = new Date(Date.now() - ALERT_WINDOW_MS).toISOString()
  const { data, error } = await db
    .from("user_shops")
    .update({ [column]: new Date().toISOString() })
    .eq("id", shopId)
    .or(`${column}.is.null,${column}.lt.${cutoff}`)
    .select("id")
  if (error) return false
  return Array.isArray(data) && data.length > 0
}

/** Tells a shop owner a storefront visitor became their sub-agent. Never throws. */
export async function notifyOwnerOfRecruit(db: Db, parentShopId: string, recruitShopName: string): Promise<void> {
  try {
    const { data: shop } = await db
      .from("user_shops")
      .select("id, user_id, shop_name")
      .eq("id", parentShopId)
      .maybeSingle()
    if (!shop?.user_id) return

    const hasPrices = await ownerHasCatalogPrices(db, parentShopId)

    const name = cleanDisplayName(recruitShopName)
    sendPushToUser(shop.user_id, {
      title: "New sub-agent",
      body: hasPrices
        ? `${name} just joined your network from your storefront.`
        : `${name} joined your network. Set your sub-agent prices so they can start selling.`,
      data: { url: hasPrices ? "/dashboard/sub-agents" : "/dashboard/sub-agent-catalog" },
    } as Parameters<typeof sendPushToUser>[1]).catch(() => {})

    if (hasPrices) return
    if (!(await claimSlot(db, parentShopId, "sub_agent_setup_alert_at"))) return

    const { data: owner } = await db
      .from("users")
      .select("phone_number, email")
      .eq("id", shop.user_id)
      .maybeSingle()

    if (owner?.phone_number) {
      try {
        await sendSMS({
          phone: owner.phone_number,
          message: SMSTemplates.subAgentCatalogNeeded(recruitShopName),
          type: "sub_agent_catalog_needed",
          reference: parentShopId,
        })
      } catch {
        console.warn("[NOTIFY-OWNER] SMS failed for shop", parentShopId)
      }
    }
    if (owner?.email) {
      try {
        const template = EmailTemplates.subAgentCatalogNeeded(
          recruitShopName,
          `${appUrl()}/dashboard/sub-agent-catalog`
        )
        await sendEmail({
          to: [{ email: owner.email }],
          subject: template.subject,
          htmlContent: template.html,
          userId: shop.user_id,
          type: "sub_agent_catalog_needed",
        })
      } catch {
        console.warn("[NOTIFY-OWNER] Email failed for shop", parentShopId)
      }
    }
  } catch {
    console.warn("[NOTIFY-OWNER] notifyOwnerOfRecruit failed for shop", parentShopId)
  }
}

/** Pushes to storefront joiners under this shop who are still waiting for prices. Never throws. */
export async function notifyWaitingSubAgents(db: Db, parentShopId: string): Promise<void> {
  try {
    const { data, error } = await db
      .from("user_shops")
      .select("user_id")
      .eq("parent_shop_id", parentShopId)
      .eq("joined_via", "storefront")
      .is("prices_set_at", null)
    if (error || !Array.isArray(data) || data.length === 0) return
    // At most one round of "prices ready" pushes per owner per 24 hours (toggling the catalog cannot re-spam).
    if (!(await claimSlot(db, parentShopId, "sub_agent_prices_ready_notified_at"))) return
    await Promise.all(
      data.map((row: { user_id: string }) =>
        Promise.resolve(
          sendPushToUser(row.user_id, {
            title: "Your prices are ready to set",
            body: "Your upline has set their sub-agent prices. Set your own prices and start selling.",
            data: { url: "/dashboard/shop-pricing?setup=1" },
          } as Parameters<typeof sendPushToUser>[1])
        ).catch(() => {})
      )
    )
  } catch {
    console.warn("[NOTIFY-OWNER] notifyWaitingSubAgents failed for shop", parentShopId)
  }
}
