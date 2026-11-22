export type FailureReason =
  | "outcome_unknown"
  | "not_enabled"
  | "out_of_balance"
  | "rate_limited"
  | "no_bundle"
  | "supplier_unavailable"
  | "wrong_number"
  | "rejected"
  | "none";

export interface FailureAttempt {
  status: string | null;
  mtnOrderId: string | null;
  message: string | null;
}

// Ordered, first match wins. Lower-cased substring checks only so the SQL
// mirror (Task 2) can use plain ILIKE '%...%'.
const KEYWORD_RULES: Array<{ reason: FailureReason; keywords: string[] }> = [
  { reason: "not_enabled", keywords: ["not enabled on mtn", "not_on_beneficiary_list", "not approved for mtn"] },
  { reason: "out_of_balance", keywords: ["insufficient", "zero or negative balance", "required: gh₵"] },
  { reason: "rate_limited", keywords: ["rate limit", "rate-limiting"] },
  { reason: "no_bundle", keywords: ["no active bundle"] },
  { reason: "supplier_unavailable", keywords: ["temporarily unavailable", "orders_paused", "on hold"] },
  { reason: "wrong_number", keywords: ["phone does not match", "phone number does not match"] },
];

/** Keyword rules only: the matching reason, or null when no keyword matches. */
export function classifyMessage(message: string | null): FailureReason | null {
  const msg = (message ?? "").toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((k) => msg.includes(k))) return rule.reason;
  }
  return null;
}

export function classifyFailureReason(a: FailureAttempt | null): FailureReason {
  if (!a) return "none";
  if (a.status === "abandoned" || (a.mtnOrderId ?? "").startsWith("UNKNOWN_")) {
    return "outcome_unknown";
  }
  if (a.status !== "failed") return "none";
  return classifyMessage(a.message) ?? "rejected";
}

export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  outcome_unknown: "Held — unclear reply",
  not_enabled: "Not enabled on MTN",
  out_of_balance: "Supplier out of balance",
  rate_limited: "Rate limited",
  no_bundle: "No bundle for size",
  supplier_unavailable: "Supplier unavailable",
  wrong_number: "Wrong network number",
  rejected: "Rejected",
  none: "—",
};
