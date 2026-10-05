import { createClient } from "@supabase/supabase-js"
import type { RefundContext, RefundGateway, GatewayOutcome } from "../types"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// credit_wallet_safely is idempotent on (user, reference), so calling it again after an
// ambiguous result can never double-credit — which is why errors here are "unknown", not "failed".
async function credit(ctx: RefundContext): Promise<GatewayOutcome> {
  const reference = `REFUND_${ctx.refundId}`
  const { error } = await supabase.rpc("credit_wallet_safely", {
    p_user_id: ctx.order.payment.walletUserId,
    p_amount: ctx.amount,
    p_reference_id: reference,
    p_description: "Order refund",
    p_source: "order_refund",
  })
  if (error) return { kind: "unknown", error: error.message }
  return { kind: "completed", ref: reference }
}

export const walletGateway: RefundGateway = {
  id: "wallet",
  label: "Customer wallet",
  supports(order) {
    if (order.payment.walletUserId) return { ok: true }
    return { ok: false, reason: "Payer has no Datagod account/wallet" }
  },
  refund: credit,
  checkStatus: (ctx) => credit(ctx),
}
