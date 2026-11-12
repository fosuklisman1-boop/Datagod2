export type SenderRole = "user" | "admin" | "ai"
export type TickState = "sent" | "delivered" | "read"

export interface ReceiptColumns {
  delivered_to_user_at: string | null
  delivered_to_admin_at: string | null
  read_by_user_at: string | null
  read_by_admin_at: string | null
}

/** Receipt of the party that did NOT send the message ("ai" counts as admin). */
export function getCounterpartReceipt(
  senderRole: SenderRole,
  row: ReceiptColumns,
): { delivered_at: string | null; read_at: string | null } {
  if (senderRole === "user") {
    return { delivered_at: row.delivered_to_admin_at, read_at: row.read_by_admin_at }
  }
  return { delivered_at: row.delivered_to_user_at, read_at: row.read_by_user_at }
}

export function getMessageTickState(r: { delivered_at: string | null; read_at: string | null }): TickState {
  if (r.read_at) return "read"
  if (r.delivered_at) return "delivered"
  return "sent"
}
