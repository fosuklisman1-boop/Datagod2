import { interpretRefundResponse, type RefundAction, type RefundOutcome } from "@/lib/refunds/ui-outcome"

/** POSTs a refund action and maps the HTTP response to a UI outcome. Never throws. */
export async function postRefundAction(
  token: string,
  path: string,
  action: RefundAction,
  body: Record<string, unknown> = {},
): Promise<RefundOutcome> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    return interpretRefundResponse(action, res.status, json)
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : "Network error" }
  }
}
