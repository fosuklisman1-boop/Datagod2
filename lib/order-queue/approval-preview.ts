import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { isStrictVerifyOn } from "@/lib/strict-verify/settings"
import { getFreshVerdicts } from "@/lib/strict-verify/verdicts"
import { normalizeNetwork, ORDER_TABLES } from "./load-snapshots"
import type { OrderType } from "./types"

export type ApprovalStatus = "approved" | "not_approved" | "not_checked"

export type ApprovalPreview = {
  enabled: boolean
  counts: { approved: number; notApproved: number; notChecked: number }
  perOrder: { id: string; status: ApprovalStatus }[]
}

/** The phone column of each order table (as in combined_orders_view). */
const PHONE_COLS: Record<OrderType, string> = {
  bulk: "phone_number",
  api: "recipient_phone",
  shop: "customer_phone",
  ussd: "recipient_phone",
  ussd_shop: "recipient_phone",
}

const CHUNK = 100

/**
 * What the picked supplier has already said about each order's number, from SAVED verdicts only
 * (never calls a supplier). Switch off => { enabled: false } and nothing is read. Only MTN orders are
 * checked; unknown, unpaid, non-MTN and unanswered/stale orders are "not_checked". Phones never leave
 * this function. Throws if an order read fails (the route returns 500).
 */
export async function previewApprovals(
  db: SupabaseClient,
  orders: { id: string; type: OrderType }[],
  supplier: string,
  now: Date,
): Promise<ApprovalPreview> {
  const empty = { approved: 0, notApproved: 0, notChecked: 0 }
  if (!(await isStrictVerifyOn(db))) return { enabled: false, counts: empty, perOrder: [] }

  const unique = new Map<string, OrderType>()
  for (const o of orders) if (!unique.has(o.id)) unique.set(o.id, o.type)

  // id -> normalised phone, for paid MTN orders only.
  const phoneOf = new Map<string, string>()
  const byType = new Map<OrderType, string[]>()
  for (const [oid, type] of unique) byType.set(type, [...(byType.get(type) ?? []), oid])
  for (const [type, ids] of byType) {
    const { table, paidCol } = ORDER_TABLES[type]
    const phoneCol = PHONE_COLS[type]
    const cols = ["id", "network", phoneCol, ...(paidCol ? [paidCol] : [])].join(", ")
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await db.from(table).select(cols).in("id", ids.slice(i, i + CHUNK))
      if (error) throw new Error(`approvalPreview: ${table} read failed`)
      for (const r of (data ?? []) as any[]) {
        if (paidCol && r[paidCol] !== "completed") continue
        if (normalizeNetwork(r.network) !== "MTN") continue
        const p = normalizeGhanaPhone(String(r[phoneCol] ?? ""))
        if (p) phoneOf.set(String(r.id), p)
      }
    }
  }

  const verdicts = new Map<string, "yes" | "no" | undefined>()
  for (const p of new Set(phoneOf.values())) {
    verdicts.set(p, (await getFreshVerdicts(db, p, [supplier], now)).get(supplier))
  }

  const counts = { ...empty }
  const perOrder: ApprovalPreview["perOrder"] = []
  for (const oid of unique.keys()) {
    const p = phoneOf.get(oid)
    const v = p ? verdicts.get(p) : undefined
    const status: ApprovalStatus = v === "yes" ? "approved" : v === "no" ? "not_approved" : "not_checked"
    if (status === "approved") counts.approved++
    else if (status === "not_approved") counts.notApproved++
    else counts.notChecked++
    perOrder.push({ id: oid, status })
  }
  return { enabled: true, counts, perOrder }
}
