import type { SupabaseClient } from "@supabase/supabase-js"
import { isCommissionTable, type RefundContact, type RefundableOrder } from "./types"

// Customer details for a MANUAL refund: the admin pays the customer by hand, so they need a name, a number to pay
// and a way to reach them. Admin-only (served by the admin-gated refund preview). Never throws: a failed lookup
// returns what the order itself knows, so the preview is never blocked.

type Row = Record<string, unknown> | null
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)

async function row(db: SupabaseClient, table: string, columns: string, id: string): Promise<Row> {
  try {
    const { data, error } = await db.from(table).select(columns).eq("id", id).maybeSingle()
    if (error) {
      console.error(`[REFUND] contact lookup on ${table} failed:`, error.message)
      return null
    }
    return (data as Row) ?? null
  } catch (err) {
    console.error(`[REFUND] contact lookup on ${table} threw:`, err instanceof Error ? err.message : err)
    return null
  }
}

export async function loadRefundContact(db: SupabaseClient, order: RefundableOrder): Promise<RefundContact | null> {
  if (isCommissionTable(order.table)) return null
  const payerPhone = order.payment.payerPhone ?? null
  let name: string | null = null
  let email: string | null = null
  let phone: string | null = null
  let recipientPhone = order.recipientPhone ?? null

  if (order.table === "shop_orders") {
    // customer_phone is the DATA RECIPIENT on storefront orders (not necessarily who paid).
    const r = await row(db, "shop_orders", "customer_name, customer_email, customer_phone", order.id)
    name = str(r?.customer_name)
    email = str(r?.customer_email)
    recipientPhone = str(r?.customer_phone) ?? recipientPhone
  } else if (order.table === "ussd_orders") {
    const r = await row(db, "ussd_orders", "dialing_phone, recipient_phone", order.id)
    phone = str(r?.dialing_phone)
    recipientPhone = str(r?.recipient_phone) ?? recipientPhone
  } else if (order.table === "ussd_shop_orders") {
    const r = await row(db, "ussd_shop_orders", "dialing_phone, recipient_phone, customer_email", order.id)
    phone = str(r?.dialing_phone)
    email = str(r?.customer_email)
    recipientPhone = str(r?.recipient_phone) ?? recipientPhone
  } else if (order.buyerUserId) {
    // orders / api_orders: paid from the ACCOUNT holder's wallet.
    const a = await account(db, order.buyerUserId)
    ;({ name, email, phone } = a)
  }

  // Any other order paid from a Datagod wallet with no payer number on record (e.g. a storefront order paid from
  // the buyer's wallet): the wallet owner is who paid, so their account fills the gaps.
  if (!payerPhone && !phone && order.payment.walletUserId && !order.buyerUserId) {
    const a = await account(db, order.payment.walletUserId)
    name = name ?? a.name
    email = email ?? a.email
    phone = a.phone
  }

  return { name, email, phone, payerPhone, recipientPhone, payTo: payerPhone ?? phone }
}

async function account(db: SupabaseClient, userId: string): Promise<{ name: string | null; email: string | null; phone: string | null }> {
  const r = await row(db, "users", "first_name, last_name, email, phone_number, phone", userId)
  return {
    name: [str(r?.first_name), str(r?.last_name)].filter(Boolean).join(" ") || null,
    email: str(r?.email),
    phone: str(r?.phone_number) ?? str(r?.phone),
  }
}
