import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession } from "../types"
import { cont, end } from "../menus"
import { setSession, deleteSession } from "../session"
import { mainMenu } from "../menus"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function handleStatus(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
    return cont(mainMenu())
  }

  const orderId = input.trim()

  // Try matching by UUID prefix or full UUID
  const { data: order } = await supabase
    .from("ussd_orders")
    .select("id, network, package_size, amount, order_status, payment_status, created_at, recipient_phone")
    .or(`id.eq.${orderId},id.ilike.${orderId}%`)
    .eq("dialing_phone", session.dialingPhone ?? '')
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  await deleteSession(sessionId)

  if (!order) {
    return end('Order not found.\nCheck the ID and\ntry again.')
  }

  const statusLabel = order.order_status === 'completed'
    ? 'Delivered'
    : order.order_status === 'failed'
    ? 'Failed'
    : order.payment_status === 'pending'
    ? 'Awaiting payment'
    : 'Processing'

  return end(
    `Order: ${order.id.slice(0, 8)}\n` +
    `${order.package_size} ${order.network}\n` +
    `To: ${order.recipient_phone}\n` +
    `GHS ${Number(order.amount).toFixed(2)}\n` +
    `Status: ${statusLabel}`
  )
}
