// lib/ussd-hubtel/special-group.ts
// A Special Bundle bought on the Hubtel USSD is N unpaid rows in hubtel_data_orders sharing a special_group_id
// (special_index 1..N). One hubtel_transactions row points at child 1, so every "fail this order" path receives only
// child 1's id and uses this to find the rest. Imported by order-tables.ts: keep it free of imports from this folder.
import type { SupabaseClient } from "@supabase/supabase-js"

export interface SpecialGroupChild {
  id: string
  special_index: number
  channel: string | null
  status: string | null
  payment_status: string | null
  paid_amount: number | string | null
  payment_reference: string | null
}

export interface SpecialGroup { groupId: string; children: SpecialGroupChild[] }

const CHILD_COLUMNS = "id, special_index, channel, status, payment_status, paid_amount, payment_reference"

/**
 * The Special group the order belongs to, children ordered by special_index. Null for a row that is not in a group,
 * a missing row, and any table other than hubtel_data_orders. THROWS on a read error (callers decide what that means).
 */
export async function readSpecialGroup(
  supabase: SupabaseClient, table: string, orderId: string,
): Promise<SpecialGroup | null> {
  if (table !== "hubtel_data_orders") return null
  const { data: row, error } = await supabase.from(table).select("special_group_id").eq("id", orderId).maybeSingle()
  if (error) throw error
  const groupId = (row as { special_group_id?: string | null } | null)?.special_group_id
  if (!groupId) return null
  const { data, error: childErr } = await supabase
    .from(table)
    .select(CHILD_COLUMNS)
    .eq("special_group_id", groupId)
    .order("special_index", { ascending: true })
  if (childErr) throw childErr
  return { groupId, children: (data ?? []) as SpecialGroupChild[] }
}
