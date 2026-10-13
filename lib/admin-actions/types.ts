export type FlowId = "withdrawal" | "afa" | "results_check" | "shop" | "sender_id" | "complaint"
export type Outcome = "approved" | "rejected" | "completed" | "resolved"

export interface AdminAlert {
  subject: string
  html: string
  pushTitle: string
  pushBody: string
  url: string
}

export interface UserMessage {
  emailSubject: string
  emailHtml: string
  sms: string
  push?: { title: string; body: string; url: string }
  inApp?: { title: string; message: string; type: string; actionUrl?: string }
}

/** Who to tell. Explicit email/phone win over what the user's account has (guest requests have no account). */
export interface Target {
  userId?: string | null
  email?: string | null
  phone?: string | null
  name?: string | null
  /** order/request id: used as the SMS/email log reference and the in-app notification reference_id */
  reference?: string
}

export interface Recipient {
  userId: string
  email: string | null
  phone: string | null
  name: string | null
}

export type ChannelName =
  | "admin_email" | "admin_push"
  | "user_email" | "user_sms" | "user_push" | "user_inapp"

export interface ChannelResult {
  channel: ChannelName
  status: "sent" | "skipped" | "failed"
  detail?: string
}

export interface NotifierDeps {
  sendEmail(p: {
    to: { email: string; name?: string }[]
    subject: string
    htmlContent: string
    userId?: string
    referenceId?: string
    type?: string
  }): Promise<unknown>
  sendSMS(p: { phone: string; message: string; type: string; reference?: string; userId?: string }): Promise<unknown>
  sendPushToUser(userId: string, p: { title: string; body: string; data?: Record<string, unknown> }): Promise<unknown>
  notifyAdminsEmail(subject: string, html: string): Promise<void>
  notifyAdminsPush(p: { title: string; body: string; data?: Record<string, unknown> }): Promise<unknown>
  insertNotification(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>
  getRecipient(userId: string): Promise<Recipient | null>
}

export interface FlowDef<C> {
  adminAlert(ctx: C): AdminAlert
  /** null = this flow does not message the user for that outcome */
  userMessage(outcome: Outcome, ctx: C): UserMessage | null
}
