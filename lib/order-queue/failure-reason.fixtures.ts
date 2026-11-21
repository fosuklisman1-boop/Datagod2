import type { FailureReason, FailureAttempt } from "./failure-reason";

// Real prod messages (digits redacted). Shared with the Task 2 SQL test.
export const FAILURE_REASON_FIXTURES: Array<{
  input: FailureAttempt | null;
  expected: FailureReason;
}> = [
  // outcome_unknown (status / id precedence beats message)
  { input: { status: "abandoned", mtnOrderId: null, message: "Hubnet returned no response — the order may have been created. Check the Hubnet dashboard before retrying." }, expected: "outcome_unknown" },
  { input: { status: "abandoned", mtnOrderId: null, message: "AgentPortalGH returned no response — the order may have been created. Check the AgentPortalGH dashboard before retrying." }, expected: "outcome_unknown" },
  { input: { status: "abandoned", mtnOrderId: null, message: "Package purchased successfully." }, expected: "outcome_unknown" },
  { input: { status: "failed", mtnOrderId: "UNKNOWN_abc", message: "Insufficient balance for 2GB" }, expected: "outcome_unknown" },

  // not_enabled
  { input: { status: "failed", mtnOrderId: null, message: "not enabled on MTN yet — you can place this order after 24 hours" }, expected: "not_enabled" },
  { input: { status: "failed", mtnOrderId: null, message: "Kuntanii: not_on_beneficiary_list" }, expected: "not_enabled" },
  { input: { status: "failed", mtnOrderId: null, message: "X is not approved for MTN purchases. Nothing was charged. The number has been sent for approval." }, expected: "not_enabled" },

  // out_of_balance
  { input: { status: "failed", mtnOrderId: null, message: "Insufficient balance for 2GB" }, expected: "out_of_balance" },
  { input: { status: "failed", mtnOrderId: null, message: "Cannot place orders with zero or negative balance. Contact admin for credit access." }, expected: "out_of_balance" },
  { input: { status: "failed", mtnOrderId: null, message: "Required: GH₵ 3.80, Available: GH₵ 1.70" }, expected: "out_of_balance" },
  { input: { status: "failed", mtnOrderId: null, message: "insufficient wallet balance: need GHS 3.90, balance GHS 2.70" }, expected: "out_of_balance" },

  // rate_limited
  { input: { status: "failed", mtnOrderId: null, message: "Hubnet is rate-limiting requests - not sent, try again in 41s" }, expected: "rate_limited" },
  { input: { status: "failed", mtnOrderId: null, message: "Hubnet is rate-limiting requests - not sent, try again in 53s" }, expected: "rate_limited" },

  // no_bundle
  { input: { status: "failed", mtnOrderId: null, message: "No active bundle found for mtn with size 4GB" }, expected: "no_bundle" },
  { input: { status: "failed", mtnOrderId: null, message: "no active bundle found for telecel with size 1GB" }, expected: "no_bundle" },

  // supplier_unavailable
  { input: { status: "failed", mtnOrderId: null, message: "Service temporarily unavailable. Please try again later." }, expected: "supplier_unavailable" },
  { input: { status: "failed", mtnOrderId: null, message: "Kuntanii 403 ORDERS_PAUSED: Orders are temporarily on hold." }, expected: "supplier_unavailable" },

  // wrong_number
  { input: { status: "failed", mtnOrderId: null, message: "Phone does not match Telecel" }, expected: "wrong_number" },
  { input: { status: "failed", mtnOrderId: null, message: "Phone does not match AirtelTigo" }, expected: "wrong_number" },
  { input: { status: "failed", mtnOrderId: null, message: "Phone number does not match MTN network" }, expected: "wrong_number" },

  // rejected (failed, no keyword / empty)
  { input: { status: "failed", mtnOrderId: null, message: "provider reported the order failed" }, expected: "rejected" },
  { input: { status: "failed", mtnOrderId: null, message: "Hubnet: order rejected" }, expected: "rejected" },
  { input: { status: "failed", mtnOrderId: null, message: "HTTP 522 (non-JSON response)" }, expected: "rejected" },
  { input: { status: "failed", mtnOrderId: null, message: null }, expected: "rejected" },
  { input: { status: "failed", mtnOrderId: null, message: "" }, expected: "rejected" },

  // none
  { input: { status: "reversed", mtnOrderId: null, message: "Kuntanii status: failed" }, expected: "none" },
  { input: { status: "reversed", mtnOrderId: null, message: "Insufficient balance for 1GB" }, expected: "none" },
  { input: { status: "completed", mtnOrderId: null, message: "Insufficient balance for 1GB" }, expected: "none" },
  { input: { status: "processing", mtnOrderId: null, message: null }, expected: "none" },
  { input: { status: "pending", mtnOrderId: null, message: null }, expected: "none" },
  { input: null, expected: "none" },
];
