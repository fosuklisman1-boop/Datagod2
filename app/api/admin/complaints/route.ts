import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, requireSupportAdmin } from "@/lib/support-auth"
import { clampDays, loadSupportOrders, loadThreadUsers, type AdminThreadUser } from "@/lib/support-admin-data"
import { fromLegacyOrderDetails, type SupportOrder } from "@/lib/support-order"
import type { SupplierResult } from "@/lib/order-supplier"

export const dynamic = "force-dynamic"

const LIST_LIMIT = 500
const DAY_MS = 86_400_000
const COLUMNS =
  "id, user_id, title, description, category, status, priority, order_id, resolution_notes, created_at, updated_at, evidence, order_details"

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })

type ComplaintRow = {
  id: string
  user_id: string
  title: string | null
  description: string | null
  category: string | null
  status: string
  priority: string | null
  order_id: string | null
  resolution_notes: string | null
  created_at: string
  updated_at: string
  evidence: unknown
  order_details: unknown
}

export interface LegacyComplaintRow extends Omit<ComplaintRow, "evidence" | "order_details"> {
  order_details: unknown
  evidence_paths: { balance_image_path: string | null; momo_receipt_path: string | null }
  has_evidence: boolean
  user: AdminThreadUser
  order: SupportOrder | null
  supplier: SupplierResult
}

const EMPTY_USER: AdminThreadUser = { first_name: null, last_name: null, email: null, phone_number: null }

function pathOf(evidence: unknown, key: string): string | null {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null
  const v = (evidence as Record<string, unknown>)[key]
  return typeof v === "string" && v.trim() !== "" ? v : null
}

export async function GET(request: NextRequest) {
  const auth = await requireSupportAdmin(request)
  if ("response" in auth) return auth.response

  try {
    const days = clampDays(request.nextUrl.searchParams.get("days"))
    const since = new Date(Date.now() - days * DAY_MS).toISOString()
    const db = getSupportDb()

    // Open rows are always listed; everything else only inside the window.
    const { data, error } = await db
      .from("complaints")
      .select(COLUMNS)
      .or(`status.in.(pending,in_review),created_at.gte.${since}`)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT)
    if (error) throw new Error("complaint list failed")
    const rows = (data ?? []) as ComplaintRow[]
    if (rows.length === 0) return NextResponse.json({ success: true, data: { complaints: [] } })

    const [users, orders] = await Promise.all([
      loadThreadUsers(db, rows.map((r) => r.user_id)),
      loadSupportOrders(db, rows.map((r) => ({ id: r.id, order_id: r.order_id, shop_order_id: null }))),
    ])

    const complaints: LegacyComplaintRow[] = rows.map(({ evidence, ...r }) => {
      const balance = pathOf(evidence, "balance_image_path")
      const momo = pathOf(evidence, "momo_receipt_path")
      const joined = r.order_id ? orders.get(r.id) : undefined
      return {
        ...r,
        evidence_paths: { balance_image_path: balance, momo_receipt_path: momo },
        has_evidence: !!(balance || momo),
        user: users.get(r.user_id) ?? EMPTY_USER,
        order: r.order_id ? joined?.order ?? null : fromLegacyOrderDetails(r.order_details),
        supplier: joined?.supplier ?? null,
      }
    })
    return NextResponse.json({ success: true, data: { complaints } })
  } catch {
    console.error("[SUPPORT] legacy complaint list failed", { adminId: auth.adminId })
    return fail("Something went wrong. Please try again.", 500)
  }
}
