import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { isValidGhanaMobile } from "@/lib/phone-format"

/**
 * GET /api/admin/users/phone-audit?bucket=missing|invalid|unverified&page=1
 *
 * Triage list for accounts the phone gate is meant to catch:
 *   - missing    : no phone number at all
 *   - invalid    : has a number that isn't a valid Ghana mobile
 *   - unverified : has a valid number but phone_verified = false
 *
 * Validity is computed in JS via the shared isValidGhanaMobile so this matches
 * the gate / withdrawal validation exactly (no second, drifting SQL regex).
 * Per-row safety signals (wallet balance, order count) are returned so the UI can
 * guard deletion of real customers. Deletion itself reuses /api/admin/remove-user.
 */
const PAGE_SIZE = 50

export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const { searchParams } = new URL(req.url)
  const bucket = (searchParams.get("bucket") || "missing") as "missing" | "invalid" | "unverified"
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1)
  // idsOnly=1 returns just the IDs of every account in the bucket (all pages), so
  // the admin UI can "select all in bucket" for a single bulk delete.
  const idsOnly = searchParams.get("idsOnly") === "1"

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    // Pull all user profiles (paginated). phone_verified may not exist in older
    // environments — fall back to a select without it.
    let withVerified = true
    const all: any[] = []
    let offset = 0
    const batch = 1000
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let q = supabase
        .from("users")
        .select(withVerified ? "id, email, phone_number, phone_verified, created_at" : "id, email, phone_number, created_at")
        .range(offset, offset + batch - 1)
      const { data, error } = await q
      if (error) {
        if (withVerified) { withVerified = false; offset = 0; all.length = 0; continue }
        throw error
      }
      if (!data || data.length === 0) break
      all.push(...data)
      if (data.length < batch) break
      offset += batch
    }

    const classify = (u: any): "missing" | "invalid" | "unverified" | "ok" => {
      const phone = (u.phone_number || "").trim()
      if (!phone) return "missing"
      if (!isValidGhanaMobile(phone)) return "invalid"
      // Only treat as unverified if we actually have the column.
      if (withVerified && u.phone_verified !== true) return "unverified"
      return "ok"
    }

    const counts = { missing: 0, invalid: 0, unverified: 0 }
    const inBucket: any[] = []
    for (const u of all) {
      const c = classify(u)
      if (c === "ok") continue
      counts[c]++
      if (c === bucket) inBucket.push(u)
    }

    inBucket.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    if (idsOnly) {
      return NextResponse.json({
        bucket,
        ids: inBucket.map((u) => u.id),
        counts: { ...counts, total: counts.missing + counts.invalid + counts.unverified },
      })
    }

    const total = inBucket.length
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const pageRows = inBucket.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    const ids = pageRows.map((u) => u.id)

    // Safety signals for just this page: wallet balance + personal order count.
    const balanceById = new Map<string, number>()
    const ordersById = new Map<string, number>()
    if (ids.length > 0) {
      const [{ data: wallets }, { data: orders }] = await Promise.all([
        supabase.from("wallets").select("user_id, balance").in("user_id", ids),
        supabase.from("orders").select("user_id").in("user_id", ids),
      ])
      wallets?.forEach((w: any) => balanceById.set(w.user_id, Number(w.balance) || 0))
      orders?.forEach((o: any) => ordersById.set(o.user_id, (ordersById.get(o.user_id) || 0) + 1))
    }

    const users = pageRows.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      phone_number: u.phone_number ?? null,
      phone_verified: withVerified ? u.phone_verified === true : null,
      created_at: u.created_at,
      bucket: classify(u),
      wallet_balance: balanceById.get(u.id) ?? 0,
      order_count: ordersById.get(u.id) ?? 0,
    }))

    return NextResponse.json({
      bucket,
      page,
      pages,
      total,
      counts: { ...counts, total: counts.missing + counts.invalid + counts.unverified },
      hasVerifiedColumn: withVerified,
      users,
    })
  } catch (error: any) {
    console.error("[PHONE-AUDIT] Error:", error)
    return NextResponse.json({ error: error.message || "Failed to load phone audit" }, { status: 500 })
  }
}
