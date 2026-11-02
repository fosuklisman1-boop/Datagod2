import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { localPhone, phoneKey } from "@/lib/sms/shop-buyers"

// Admin "do not text" list for marketing SMS (sms_marketing_opt_outs, migration 0145).
// Numbers are stored by their last 9 digits, so 024…, 233… and +233… are one entry.

const MAX_PER_REQUEST = 5000

/**
 * Accepts an array or one string of numbers separated by commas, semicolons or new lines.
 * A piece is split on spaces only when it holds more digits than one number can, so
 * "+233 24 123 4567" stays one number while "0241234567 0201112222" becomes two.
 */
function parsePhones(input: unknown): { keys: string[]; invalid: string[] } {
  const pieces = Array.isArray(input) ? input.map(String) : String(input ?? "").split(/[,;\r\n]+/)
  const raw = pieces.flatMap((p) => (p.replace(/\D/g, "").length > 13 ? p.split(/\s+/) : [p]))
  const keys = new Set<string>()
  const invalid: string[] = []
  for (const p of raw.map((s) => s.trim()).filter(Boolean)) {
    const k = phoneKey(p)
    if (k) keys.add(k)
    else invalid.push(p)
  }
  return { keys: [...keys], invalid }
}

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const { data, error, count } = await supabaseAdmin
    .from("sms_marketing_opt_outs")
    .select("phone_key, reason, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) return NextResponse.json({ success: false, error: "Failed to load opt-outs" }, { status: 500 })
  return NextResponse.json({
    success: true,
    data: {
      total: count ?? 0,
      items: (data ?? []).map((r: { phone_key: string; reason: string | null; created_at: string }) => ({
        phone: localPhone(r.phone_key), reason: r.reason, created_at: r.created_at,
      })),
    },
  })
}

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  let body: { phones?: unknown; reason?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }

  const { keys, invalid } = parsePhones(body.phones)
  if (keys.length === 0) return NextResponse.json({ success: false, error: "No valid Ghana mobile numbers", invalid }, { status: 400 })
  if (keys.length > MAX_PER_REQUEST) return NextResponse.json({ success: false, error: `At most ${MAX_PER_REQUEST} numbers at a time` }, { status: 400 })
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : null

  const { error } = await supabaseAdmin
    .from("sms_marketing_opt_outs")
    .upsert(keys.map((phone_key) => ({ phone_key, reason, added_by: auth.userId ?? null })), { onConflict: "phone_key", ignoreDuplicates: true })
  if (error) return NextResponse.json({ success: false, error: "Failed to save opt-outs" }, { status: 500 })
  return NextResponse.json({ success: true, data: { added: keys.length, invalid } })
}

export async function DELETE(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  let body: { phones?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }

  const { keys } = parsePhones(body.phones)
  if (keys.length === 0) return NextResponse.json({ success: false, error: "No valid numbers" }, { status: 400 })
  const { error } = await supabaseAdmin.from("sms_marketing_opt_outs").delete().in("phone_key", keys)
  if (error) return NextResponse.json({ success: false, error: "Failed to remove opt-outs" }, { status: 500 })
  return NextResponse.json({ success: true, data: { removed: keys.length } })
}
