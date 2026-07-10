import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"

function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[\s\-\(\)]/g, "")
  if (cleaned.startsWith("+233") && cleaned.length === 13) return "0" + cleaned.slice(4)
  if (cleaned.startsWith("233") && cleaned.length === 12) return "0" + cleaned.slice(3)
  if (cleaned.startsWith("0") && cleaned.length === 10) return cleaned
  if (/^\d{9}$/.test(cleaned)) return "0" + cleaned
  return cleaned
}

// GET — list all whitelisted numbers
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase
    .from("ussd_whitelist")
    .select("phone_number, created_at")
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[USSD Whitelist Numbers] GET error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, numbers: data ?? [], count: data?.length ?? 0 })
}

// POST — bulk upload numbers
// Body: { numbers: string[] }  (raw strings; will be normalised before insert)
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  let numbers: string[]
  try {
    const body = await request.json()
    if (!Array.isArray(body.numbers)) {
      return NextResponse.json({ error: "numbers must be an array" }, { status: 400 })
    }
    numbers = body.numbers
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // Normalise and deduplicate
  const rows = Array.from(
    new Set(
      numbers
        .map((n) => normalizePhone(String(n).trim()))
        .filter((n) => /^0\d{9}$/.test(n))
    )
  ).map((phone_number) => ({ phone_number }))

  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid Ghanaian phone numbers found" }, { status: 400 })
  }

  const { error } = await supabase
    .from("ussd_whitelist")
    .upsert(rows, { onConflict: "phone_number", ignoreDuplicates: true })

  if (error) {
    console.error("[USSD Whitelist Numbers] POST error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, added: rows.length, skipped: numbers.length - rows.length })
}

// DELETE — remove a single number
// Body: { phone_number: string }
export async function DELETE(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  let phone_number: string
  try {
    const body = await request.json()
    phone_number = normalizePhone(String(body.phone_number ?? "").trim())
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!phone_number) {
    return NextResponse.json({ error: "phone_number is required" }, { status: 400 })
  }

  const { error } = await supabase
    .from("ussd_whitelist")
    .delete()
    .eq("phone_number", phone_number)

  if (error) {
    console.error("[USSD Whitelist Numbers] DELETE error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
