import { createClient } from "@supabase/supabase-js"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const SHORTFALL_TYPE = "sms_credit_shortfall"
const THROTTLE_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Fire-and-forget admin alert: insert one in-app notification per admin when the
 * Moolre wholesale SMS balance is insufficient to cover pending unit credits.
 * Throttled: skips if a shortfall notification was already inserted in the last
 * 30 minutes to avoid spamming admins.
 */
export async function notifyAdminSmsShortfall(unitsPending: number): Promise<void> {
  try {
    // --- Throttle check ---
    const thirtyMinutesAgo = new Date(Date.now() - THROTTLE_MS).toISOString()
    const { data: existing } = await supabaseAdmin
      .from("notifications")
      .select("id")
      .eq("type", SHORTFALL_TYPE)
      .gte("created_at", thirtyMinutesAgo)
      .limit(1)

    if (existing && existing.length > 0) {
      console.log("[SMS-NOTIFY] Shortfall notification throttled (sent within 30 min)")
      return
    }

    // --- Look up admin user ids ---
    const { data: admins, error: adminsError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("role", "admin")

    if (adminsError) {
      console.error("[SMS-NOTIFY] Failed to fetch admin users:", adminsError.message)
      return
    }

    if (!admins || admins.length === 0) {
      console.warn("[SMS-NOTIFY] No admin users found; skipping shortfall notification")
      return
    }

    // --- Insert one notification per admin ---
    const now = new Date().toISOString()
    const rows = admins.map((admin: { id: string }) => ({
      user_id: admin.id,
      title: "SMS wholesale top-up needed",
      message: `${unitsPending} units are pending — top up the Moolre SMS wholesale balance to release them.`,
      type: SHORTFALL_TYPE,
      read: false,
      action_url: "/admin/sms",
      created_at: now,
      updated_at: now,
    }))

    const { error: insertError } = await supabaseAdmin
      .from("notifications")
      .insert(rows)

    if (insertError) {
      console.error("[SMS-NOTIFY] Failed to insert shortfall notifications:", insertError.message)
      return
    }

    console.log(`[SMS-NOTIFY] Shortfall alert sent to ${admins.length} admin(s) (${unitsPending} units pending)`)
  } catch (error) {
    console.error("[SMS-NOTIFY] Unexpected error in notifyAdminSmsShortfall:", error)
  }
}
