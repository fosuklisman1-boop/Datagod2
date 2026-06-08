import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "")
  if (digits.startsWith("233")) return "0" + digits.slice(3)
  if (digits.startsWith("0") && digits.length === 10) return digits
  return digits
}

export async function POST(request: NextRequest) {
  const rl = await applyRateLimit(request, "voucher_lookup", 5, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 })
  }

  try {
    const { phone, reference } = await request.json()

    if (!phone && !reference) {
      return NextResponse.json({ error: "Provide a phone number or reference code." }, { status: 400 })
    }

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    let query = supabase
      .from("results_checker_orders")
      // Deliberately exclude `id` (UUID) — it is not needed by the lookup UI and
      // would allow an attacker to chain phone-lookup → orderId → resend spam.
      // Exclude `total_paid` — financial detail not needed for self-service lookup.
      .select("reference_code, exam_board, quantity, created_at, customer_phone")
      .eq("status", "completed")

    if (reference) {
      const ref = String(reference).trim().toUpperCase()
      query = query.eq("reference_code", ref)
    } else {
      const local = normalizePhone(String(phone).trim())
      if (!/^0[0-9]{9}$/.test(local)) {
        return NextResponse.json({ error: "Enter a valid 10-digit Ghana phone number." }, { status: 400 })
      }
      query = query
        .or(`customer_phone.eq.${local},dialing_phone.eq.${local}`)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(5)
    }

    const { data: orders, error } = await query
    if (error) throw error

    return NextResponse.json({ orders: orders ?? [] })
  } catch (err) {
    console.error("[VOUCHER-LOOKUP]", err)
    return NextResponse.json({ error: "Internal server error." }, { status: 500 })
  }
}
