import type { NotifierDeps, Recipient } from "./types"

async function db() {
  const { supabaseAdmin } = await import("@/lib/supabase")
  return supabaseAdmin
}

export function getDefaultDeps(): NotifierDeps {
  return {
    async sendEmail(p) {
      const { sendEmail } = await import("@/lib/email-service")
      const r = await sendEmail(p)
      if (r && r.success === false) throw new Error(r.error || "email send failed")
      return r
    },
    async sendSMS(p) {
      const { sendSMS } = await import("@/lib/sms-service")
      const r = await sendSMS(p)
      if (r && r.success === false && !r.skipped) throw new Error(r.error || "sms send failed")
      return r
    },
    async sendPushToUser(userId, p) {
      const { sendPushToUser } = await import("@/lib/push-service")
      return sendPushToUser(userId, p)
    },
    async notifyAdminsEmail(subject, html) {
      const { notifyAdmins } = await import("@/lib/email-service")
      await notifyAdmins(subject, html)
    },
    async notifyAdminsPush(p) {
      const { notifyAdminsPush } = await import("@/lib/push-service")
      return notifyAdminsPush(p)
    },
    async insertNotification(row) {
      const client = await db()
      const { error } = await client.from("notifications").insert([row])
      return { error: error ? { message: error.message } : null }
    },
    async getRecipient(userId): Promise<Recipient | null> {
      const client = await db()
      const { data, error } = await client.from("users").select("email, phone_number, first_name").eq("id", userId).maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return null
      return { userId, email: data.email ?? null, phone: data.phone_number ?? null, name: data.first_name ?? null }
    },
  }
}
