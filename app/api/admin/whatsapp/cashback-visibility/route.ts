// GET / POST /api/admin/whatsapp/cashback-visibility
// The WhatsApp bots' (main + shop) commission-cashback switches: admin_settings `whatsapp_cashback_visibility`
// = { networkPlans, payBills, cashbackAirtime } (lib/whatsapp-bot/cashback-visibility.ts). Admin only.
// - GET  => { switches: stored (strict read: an error is a 500, never "all off"), live: what the bots offer right now
//            (switch AND the shared cashback bots gate) }
// - POST { networkPlans?, payBills?, cashbackAirtime? } (booleans, only these keys, at least one), validated before any
//        DB access => the same shape as GET. Best-effort audit row (admin_audit_log).
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  getWhatsAppCashbackVisibilityStrict, setWhatsAppCashbackVisibility, whatsappBotItemsVisible,
  type WhatsAppCashbackVisibility,
} from "@/lib/whatsapp-bot/cashback-visibility"

const SWITCH_KEYS = ["networkPlans", "payBills", "cashbackAirtime"] as const

const adminClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

const FORBIDDEN = () => NextResponse.json({ error: "Admin access required" }, { status: 403 })
const BAD_BODY = () =>
  NextResponse.json({ error: `Body must set one or more of ${SWITCH_KEYS.join(", ")} to true or false` }, { status: 400 })

/** The patch, or null when the body is not a plain object of known switch keys with boolean values (at least one). */
function parsePatch(body: unknown): Partial<WhatsAppCashbackVisibility> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null
  const entries = Object.entries(body as Record<string, unknown>)
  if (entries.length === 0) return null
  const patch: Partial<WhatsAppCashbackVisibility> = {}
  for (const [k, v] of entries) {
    if (!(SWITCH_KEYS as readonly string[]).includes(k) || typeof v !== "boolean") return null
    patch[k as keyof WhatsAppCashbackVisibility] = v
  }
  return patch
}

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  // A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it.
  if (!isAdmin || errorResponse) return errorResponse ?? FORBIDDEN()
  const db = adminClient()
  try {
    const switches = await getWhatsAppCashbackVisibilityStrict(db)
    const live = await whatsappBotItemsVisible(db)
    return NextResponse.json({ switches, live })
  } catch (e) {
    console.error("[WA-CASHBACK-ADMIN] GET error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Failed to load the WhatsApp cashback switches" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin || errorResponse) return errorResponse ?? FORBIDDEN()
  let body: unknown
  try { body = await request.json() } catch { return BAD_BODY() }
  const patch = parsePatch(body)
  if (!patch) return BAD_BODY()

  const db = adminClient()
  try {
    const before = await getWhatsAppCashbackVisibilityStrict(db)
    await setWhatsAppCashbackVisibility(db, patch)
    const switches = await getWhatsAppCashbackVisibilityStrict(db)
    db.from("admin_audit_log").insert([{
      admin_id: userId, action: "whatsapp_cashback_visibility_update", target_user_id: null,
      old_value: before, new_value: switches, created_at: new Date().toISOString(),
    }]).then(({ error }: { error: { message: string } | null }) => {
      if (error) console.warn("[ADMIN-AUDIT] whatsapp_cashback_visibility_update log failed:", error.message)
    })
    const live = await whatsappBotItemsVisible(db)
    return NextResponse.json({ switches, live })
  } catch (e) {
    console.error("[WA-CASHBACK-ADMIN] POST error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Failed to save the WhatsApp cashback switches" }, { status: 500 })
  }
}
