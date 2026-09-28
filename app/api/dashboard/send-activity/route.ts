import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { normalizeNetwork, type HealthNetwork } from "@/lib/order-health-service"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const DAY_MS = 86_400_000

// Accra has no DST, so this is a fixed UTC+0 offset — good enough for
// bucketing into calendar days without pulling in a timezone library.
function accraDateKey(iso: string): string {
  return new Date(new Date(iso).getTime()).toLocaleDateString("en-CA", { timeZone: "Africa/Accra" })
}

/**
 * The logged-in user's own last-7-days order activity, grouped by day and by
 * network — a personal "am I actually selling" signal, distinct from Network
 * Health (which is platform-wide across every account). Only orders/api_orders
 * carry a buyer user_id (shop/ussd orders don't), so this only looks at those
 * two. Counts "completed" orders only — pending/failed weren't actually
 * delivered, so counting them would overstate real send activity.
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing or invalid authorization header" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const since = new Date(Date.now() - 6 * DAY_MS).toISOString()

    const [ordersRes, apiOrdersRes] = await Promise.all([
      supabase.from("orders").select("network, created_at").eq("user_id", user.id).eq("status", "completed").gte("created_at", since),
      supabase.from("api_orders").select("network, created_at").eq("user_id", user.id).eq("status", "completed").gte("created_at", since),
    ])

    if (ordersRes.error) throw ordersRes.error
    if (apiOrdersRes.error) throw apiOrdersRes.error

    const rows = [...(ordersRes.data ?? []), ...(apiOrdersRes.data ?? [])] as { network: string; created_at: string }[]

    // Build the last 7 calendar days (oldest first, ending today), Accra time.
    const days: { date: string; label: string; counts: Record<HealthNetwork, number> }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY_MS)
      const date = accraDateKey(d.toISOString())
      const label = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "Africa/Accra" }).format(d)
      days.push({ date, label, counts: { MTN: 0, Telecel: 0, "AT - iShare": 0, "AT - BigTime": 0 } })
    }
    const byDate = new Map(days.map((d) => [d.date, d]))

    for (const row of rows) {
      const network = normalizeNetwork(row.network)
      if (!network) continue
      const bucket = byDate.get(accraDateKey(row.created_at))
      if (!bucket) continue
      bucket.counts[network]++
    }

    return NextResponse.json({ success: true, days })
  } catch (error) {
    console.error("[SEND-ACTIVITY] Error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Internal server error", days: [] },
      { status: 500 }
    )
  }
}
