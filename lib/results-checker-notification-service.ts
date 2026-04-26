import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { VoucherPin } from "@/lib/results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function deliverVouchers(
  order: Record<string, any>,
  vouchers: VoucherPin[]
): Promise<void> {
  const phone = order.customer_phone
  const email = order.customer_email
  const deliveredVia: string[] = ["screen"]

  const tasks: Promise<any>[] = []

  if (phone) {
    tasks.push(
      sendSMS({
        phone,
        message: SMSTemplates.resultsCheckerDelivery(order.exam_board, order.reference_code, vouchers),
        type: "results_checker_delivery",
        reference: order.id,
        userId: order.user_id ?? undefined,
      }).then(() => {
        deliveredVia.push("sms")
      }).catch(e => console.warn("[RC-NOTIFY] SMS failed:", e))
    )
  }

  if (email) {
    tasks.push(
      import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
        const payload = EmailTemplates.resultsCheckerDelivery(
          order.reference_code,
          order.exam_board,
          order.quantity,
          order.total_paid,
          vouchers
        )
        return sendEmail({
          to: [{ email }],
          subject: payload.subject,
          htmlContent: payload.html,
          referenceId: order.id,
          type: "results_checker_delivery",
        })
      }).then(() => {
        deliveredVia.push("email")
      }).catch(e => console.warn("[RC-NOTIFY] Email failed:", e))
    )
  }

  await Promise.allSettled(tasks)

  // Update delivered_via on the order (best-effort)
  await supabase
    .from("results_checker_orders")
    .update({ delivered_via: deliveredVia, updated_at: new Date().toISOString() })
    .eq("id", order.id)
    .catch(e => console.warn("[RC-NOTIFY] Failed to update delivered_via:", e))
}

export async function resendVouchers(
  orderId: string,
  method: "sms" | "email"
): Promise<{ success: boolean; message: string }> {
  const { data: order } = await supabase
    .from("results_checker_orders")
    .select("*")
    .eq("id", orderId)
    .eq("status", "completed")
    .single()

  if (!order) return { success: false, message: "Order not found or not completed" }

  const { data: vouchers } = await supabase
    .from("results_checker_inventory")
    .select("id, pin, serial_number")
    .in("id", order.inventory_ids ?? [])

  if (!vouchers || vouchers.length === 0) {
    return { success: false, message: "No vouchers found for this order" }
  }

  if (method === "sms") {
    if (!order.customer_phone) return { success: false, message: "No phone number on record" }
    await sendSMS({
      phone: order.customer_phone,
      message: SMSTemplates.resultsCheckerDelivery(order.exam_board, order.reference_code, vouchers),
      type: "results_checker_resend_sms",
      reference: order.id,
    })
  } else {
    if (!order.customer_email) return { success: false, message: "No email address on record" }
    const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
    const payload = EmailTemplates.resultsCheckerDelivery(
      order.reference_code,
      order.exam_board,
      order.quantity,
      order.total_paid,
      vouchers
    )
    await sendEmail({
      to: [{ email: order.customer_email }],
      subject: payload.subject,
      htmlContent: payload.html,
      referenceId: order.id,
      type: "results_checker_resend_email",
    })
  }

  return { success: true, message: `Vouchers resent via ${method}` }
}
