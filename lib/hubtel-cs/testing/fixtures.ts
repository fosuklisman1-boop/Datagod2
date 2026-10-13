import type { HubtelCsTx } from "../types"

export const T0 = new Date("2026-10-13T10:00:00.000Z")
export const minutesAfter = (m: number) => new Date(T0.getTime() + m * 60_000)

export function makeTx(over: Partial<HubtelCsTx> = {}): HubtelCsTx {
  const ts = T0.toISOString()
  return {
    id: "tx-1", client_reference: "HCS-airtime_mtn-TESTREF1", service_key: "airtime_mtn", kind: "airtime",
    destination: "233246912184", amount: 5, bundle: null, extra: null, state: "created",
    response_code: null, response_message: null, failure_reason: null,
    hubtel_transaction_id: null, external_transaction_id: null,
    commission: null, charges: null, amount_debited: null, order_table: null, order_id: null,
    submitted_at: null, completed_at: null, callback_received_at: null,
    status_check_attempts: 0, negative_checks: 0, last_status_check_at: null,
    review_reason: null, resolved_by: null, resolved_at: null, resolution_note: null,
    created_at: ts, updated_at: ts,
    ...over,
  }
}
