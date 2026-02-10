import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Brevo API Configuration
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"
const BREVO_API_KEY = process.env.BREVO_API_KEY
const SENDER_NAME = process.env.EMAIL_SENDER_NAME || "DataGod"
const SENDER_EMAIL = process.env.EMAIL_SENDER_ADDRESS || "noreply@datagod.com"

export interface EmailRecipient {
  email: string
  name?: string
}

export interface EmailPayload {
  to: EmailRecipient[]
  subject: string
  htmlContent: string
  userId?: string // For logging
  referenceId?: string // For logging
  type?: string // For logging (e.g., 'order_confirmation')
}

export interface BatchEmailPayload {
  subject: string
  htmlContent: string
  recipients: EmailRecipient[] // List of recipients for the *same* email content
  type?: string
}

interface BrevoResponse {
  messageId: string
}

/**
 * Standard HTML Wrapper for consistent email styling
 */
function wrapHtml(content: string, title: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f9fafb; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background-color: #000000; color: #ffffff; padding: 20px; text-align: center; }
        .content { padding: 30px 20px; }
        .footer { background-color: #f3f4f6; color: #6b7280; padding: 20px; text-align: center; font-size: 12px; }
        .button { display: inline-block; background-color: #000000; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; margin-top: 15px; }
        .alert { padding: 10px; border-radius: 4px; margin-bottom: 15px; }
        .alert-error { background-color: #fee2e2; color: #991b1b; }
        .alert-success { background-color: #dcfce7; color: #166534; }
        table { width: 100%; border-collapse: collapse; margin: 15px 0; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e5e7eb; }
        th { font-weight: 600; color: #4b5563; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${title}</h1>
        </div>
        <div class="content">
          ${content}
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} ${SENDER_NAME}. All rights reserved.</p>
          <p>This is an automated message, please do not reply directly.</p>
        </div>
      </div>
    </body>
    </html>
  `
}

// Email Templates (Mirrors SMSTemplates)
export const EmailTemplates = {
  walletTopUpInitiated: (amount: string, ref: string) => ({
    subject: "Wallet Top-up Initiated",
    html: wrapHtml(`
      <p>A wallet top-up request has been initiated.</p>
      <table>
        <tr><th>Amount</th><td>GHS ${amount}</td></tr>
        <tr><th>Reference</th><td>${ref}</td></tr>
        <tr><th>Status</th><td>Processing payment...</td></tr>
      </table>
      <p>Your balance will be updated automatically once payment is confirmed.</p>
    `, "Wallet Top-up"),
  }),

  welcomeEmail: (firstName: string) => ({
    subject: `Welcome to ${SENDER_NAME}!`,
    html: wrapHtml(`
      <div class="alert alert-success">Welcome to the family!</div>
      <p>Hi ${firstName},</p>
      <p>Thank you for joining ${SENDER_NAME}. We are excited to have you on board.</p>
      <p>You can now:</p>
      <ul>
        <li>Purchase affordable data bundles</li>
        <li>Manage your wallet</li>
        <li>Apply to become a shop owner</li>
      </ul>
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard" class="button">Go to Dashboard</a></p>
    `, "Welcome"),
  }),

  walletTopUpSuccess: (amount: string, balance: string, ref: string) => ({
    subject: "✓ Wallet Top-up Successful",
    html: wrapHtml(`
      <div class="alert alert-success">Your wallet has been successfully funded!</div>
      <p>Thank you for topping up your wallet.</p>
      <table>
        <tr><th>Amount Credited</th><td>GHS ${amount}</td></tr>
        <tr><th>New Balance</th><td>GHS ${balance}</td></tr>
        <tr><th>Reference</th><td>${ref}</td></tr>
      </table>
    `, "Payment Received"),
  }),

  walletTopUpFailed: (amount: string, ref: string) => ({
    subject: "✗ Wallet Top-up Failed",
    html: wrapHtml(`
      <div class="alert alert-error">The top-up transaction could not be completed.</div>
      <p>We attempted to process your top-up but encountered an issue.</p>
      <table>
        <tr><th>Amount</th><td>GHS ${amount}</td></tr>
        <tr><th>Reference</th><td>${ref}</td></tr>
      </table>
      <p>If you have been debited, please contact support immediately with your reference code.</p>
    `, "Transaction Failed"),
  }),

  orderCreated: (orderId: string, network: string, volume: string, amount: string) => ({
    subject: `Order Confirmed: ${network} ${volume}GB`,
    html: wrapHtml(`
      <p>Your order has been placed successfully and is pending payment/processing.</p>
      <table>
        <tr><th>Order ID</th><td>${orderId}</td></tr>
        <tr><th>Package</th><td>${network} ${volume}GB</td></tr>
        <tr><th>Amount</th><td>GHS ${amount}</td></tr>
      </table>
    `, "Order Confirmation"),
  }),

  orderPaymentConfirmed: (orderId: string, network: string, volume: string, amount: string) => ({
    subject: `✓ Payment Confirmed: Order #${orderId}`,
    html: wrapHtml(`
      <div class="alert alert-success">Payment received! Your order is now processing.</div>
      <table>
        <tr><th>Order ID</th><td>${orderId}</td></tr>
        <tr><th>Package</th><td>${network} ${volume}GB</td></tr>
        <tr><th>Amount Paid</th><td>GHS ${amount}</td></tr>
      </table>
      <p>You will receive a notification once the data bundle is delivered.</p>
    `, "Payment Confirmed"),
  }),

  orderDelivered: (orderId: string, network: string, volume: string) => ({
    subject: `✓ Order Delivered: #${orderId}`,
    html: wrapHtml(`
      <div class="alert alert-success">Your data bundle has been delivered!</div>
      <p>Enjoy your ${network} ${volume}GB data package.</p>
      <p>Thank you for choosing ${SENDER_NAME}.</p>
    `, "Order Delivered"),
  }),

  orderFailed: (orderId: string, reason: string) => ({
    subject: `✗ Order Failed: #${orderId}`,
    html: wrapHtml(`
      <div class="alert alert-error">We could not fulfill your order.</div>
      <p>Unfortunately, your order #${orderId} failed.</p>
      <p><strong>Reason:</strong> ${reason}</p>
      <p>Any deducted funds have been refunded to your wallet.</p>
    `, "Order Failed"),
  }),

  withdrawalApproved: (amount: string, ref: string) => ({
    subject: "✓ Withdrawal Approved",
    html: wrapHtml(`
      <p>Your withdrawal request has been approved and processed.</p>
      <table>
        <tr><th>Amount</th><td>GHS ${amount}</td></tr>
        <tr><th>Reference</th><td>${ref}</td></tr>
      </table>
      <p>The funds should reflect in your account shortly.</p>
    `, "Withdrawal Approved"),
  }),

  withdrawalRejected: (amount: string, reason?: string) => ({
    subject: "✗ Withdrawal Request Rejected",
    html: wrapHtml(`
      <p>Your withdrawal request for GHS ${amount} was rejected.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
      <p>Please contact support for more information.</p>
    `, "Withdrawal Rejected"),
  }),

  shopApproved: (shopName: string, shopId: string) => ({
    subject: "🎉 Shop Approved!",
    html: wrapHtml(`
      <div class="alert alert-success">Your shop "${shopName}" has been approved!</div>
      <p>Congratulations! You can now start selling on our platform.</p>
      <p>Visit your dashboard to manage your shop and view orders.</p>
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/shop" class="button">Go to Shop Dashboard</a></p>
    `, "Shop Approved"),
  }),

  shopRejected: (shopName: string, shopId: string, reason?: string) => ({
    subject: "Shop Verification Status",
    html: wrapHtml(`
      <p>Your shop "${shopName}" application was not approved.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
      <p>Please review our guidelines and contact support if you have questions.</p>
    `, "Shop Rejected"),
  }),

  // Admin Alerts
  fulfillmentFailed: (orderId: string, phone: string, network: string, sizeGb: string, reason: string) => ({
    subject: `[ALERT] Fulfillment Failed: #${orderId}`,
    html: wrapHtml(`
      <div class="alert alert-error">Automated fulfillment failed for an order.</div>
      <table>
        <tr><th>Order ID</th><td>${orderId}</td></tr>
        <tr><th>Customer</th><td>${phone}</td></tr>
        <tr><th>Package</th><td>${network} ${sizeGb}GB</td></tr>
        <tr><th>Reason</th><td>${reason}</td></tr>
      </table>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/orders" class="button">View Order in Admin</a>
    `, "Fulfillment Alert"),
  }),

  priceManipulationDetected: (phone: string, clientPrice: string, actualPrice: string, network: string, volume: string) => ({
    subject: `[FRAUD] Price Manipulation Detected`,
    html: wrapHtml(`
      <div class="alert alert-error"><strong>CRITICAL:</strong> Price manipulation attempt detected.</div>
      <table>
        <tr><th>User Phone</th><td>${phone}</td></tr>
        <tr><th>Package</th><td>${network} ${volume}GB</td></tr>
        <tr><th>Client Sent Price</th><td>GHS ${clientPrice}</td></tr>
        <tr><th>Actual System Price</th><td>GHS ${actualPrice}</td></tr>
      </table>
      <p>This user may be attempting to tamper with client-side code.</p>
    `, "Security Alert"),
  }),

  paymentMismatchDetected: (reference: string, paidAmount: string, expectedAmount: string) => ({
    subject: `[ALERT] Payment Mismatch: ${reference}`,
    html: wrapHtml(`
      <div class="alert alert-error"><strong>Payment Underpayment Detected</strong></div>
      <p>A payment was received but it does not match the expected amount.</p>
      <table>
        <tr><th>Reference</th><td>${reference}</td></tr>
        <tr><th>Paid Amount</th><td>GHS ${paidAmount}</td></tr>
        <tr><th>Expected Amount</th><td>GHS ${expectedAmount}</td></tr>
        <tr><th>Difference</th><td>GHS ${(parseFloat(expectedAmount) - parseFloat(paidAmount)).toFixed(2)}</td></tr>
      </table>
      <p>Please investigate this transaction.</p>
    `, "Payment Alert"),
  }),

  // Subscription Alerts
  subscriptionExpiry1Day: (planName: string, expiryDate: string) => ({
    subject: "Subscription Expiring in 24 Hours",
    html: wrapHtml(`
      <p>Your <strong>${planName}</strong> subscription will expire in approximately 24 hours.</p>
      <p><strong>Expiry Date:</strong> ${expiryDate}</p>
      <p>Please renew your subscription to avoid losing access to dealer pricing and features.</p>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/subscription" class="button">Renew Subscription</a>
    `, "Subscription Expiry Warning"),
  }),

  subscriptionExpiry12Hours: (planName: string, expiryDate: string) => ({
    subject: "Subscription Expiring in 12 Hours",
    html: wrapHtml(`
      <p>Your <strong>${planName}</strong> subscription is expiring in 12 hours.</p>
      <p><strong>Expiry Date:</strong> ${expiryDate}</p>
      <p>Don't miss out on dealer benefits. Renew now.</p>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/subscription" class="button">Renew Subscription</a>
    `, "Subscription Expiry Warning"),
  }),

  subscriptionExpiry6Hours: (planName: string, expiryDate: string) => ({
    subject: "URGENT: Subscription Expiring in 6 Hours",
    html: wrapHtml(`
      <div class="alert alert-error">Your subscription expires in just 6 hours!</div>
      <p>Your <strong>${planName}</strong> subscription is ending soon.</p>
      <p><strong>Expiry Date:</strong> ${expiryDate}</p>
      <p>Renew immediately to ensure uninterrupted service.</p>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/subscription" class="button">Renew Now</a>
    `, "Urgent Expiry Warning"),
  }),

  subscriptionExpiry1Hour: (planName: string, expiryDate: string) => ({
    subject: "FINAL CALL: Subscription Expiring in 1 Hour",
    html: wrapHtml(`
      <div class="alert alert-error"><strong>Action Required:</strong> Subscription expires in 1 hour.</div>
      <p>Your <strong>${planName}</strong> plan is about to expire.</p>
      <p><strong>Expiry Date:</strong> ${expiryDate}</p>
      <p>Renew now to keep your dealer status active.</p>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/subscription" class="button">Renew Immediately</a>
    `, "Final Expiry Warning"),
  }),
}

/**
 * Send a generic email via Brevo API
 */
export async function sendEmail(payload: EmailPayload): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!BREVO_API_KEY) {
    console.warn("[Email] BREVO_API_KEY is missing. Email skipped:", payload.subject)
    return { success: false, error: "Configuration missing" }
  }

  try {
    console.log(`[Email] Sending '${payload.subject}' to ${payload.to.length} recipient(s)`)

    const body = {
      sender: {
        name: SENDER_NAME,
        email: SENDER_EMAIL,
      },
      to: payload.to,
      subject: payload.subject,
      htmlContent: payload.htmlContent,
    }

    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Email] API Failed: ${response.status}`, errorText)
      throw new Error(`Brevo API Error: ${response.status} ${errorText}`)
    }

    const data: BrevoResponse = await response.json()
    console.log(`[Email] Sent successfully. ID: ${data.messageId}`)

    // Log to DB if user ID provided
    if (payload.userId) {
      await logEmail(payload, "sent", data.messageId)
    }

    return { success: true, messageId: data.messageId }

  } catch (error: any) {
    console.error("[Email] Send failed:", error)

    if (payload.userId) {
      await logEmail(payload, "failed", undefined, error.message)
    }

    return { success: false, error: error.message }
  }
}

/**
 * Log email to database
 */
async function logEmail(payload: EmailPayload, status: "sent" | "failed", messageId?: string, errorMessage?: string) {
  try {
    // We'll reuse the sms_logs table or create a new email_logs table?
    // For now, let's assume we might want to create a dedicated table later,
    // but since the schema wasn't requested, we will skip DB logging for now or log to console.
    // If 'email_logs' table existed:
    /*
    await supabase.from('email_logs').insert({
        user_id: payload.userId,
        subject: payload.subject,
        recipient: payload.to[0].email,
        status,
        message_id: messageId,
        error_message: errorMessage,
        type: payload.type
    })
    */
    console.log(`[Email] Logging to DB skipped (table not created yet). Status: ${status}`)
  } catch (e) {
    console.error("[Email] Failed to log email:", e)
  }
}

/**
 * Send email to all admins
 */
export async function notifyAdmins(subject: string, htmlContent: string): Promise<void> {
  try {
    // Fetch admin emails
    const { data: admins } = await supabase
      .from('users')
      .select('email')
      .eq('role', 'admin')

    if (!admins || admins.length === 0) {
      console.warn("[Email] No admins found to notify")
      return
    }

    const validAdmins = admins.filter(a => a.email && a.email.includes('@')).map(a => ({ email: a.email }))

    if (validAdmins.length === 0) return

    await sendEmail({
      to: validAdmins,
      subject,
      htmlContent
    })
  } catch (error) {
    console.error("[Email] Failed to notify admins:", error)
  }
}

/**
 * Send batch emails via Brevo API
 * Suitable for cron jobs (up to 1000 recipients per call)
 */
export async function sendBatchEmails(payload: BatchEmailPayload): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!BREVO_API_KEY) {
    console.warn("[Email] BREVO_API_KEY is missing. Batch email skipped.")
    return { success: false, error: "Configuration missing" }
  }

  try {
    console.log(`[Email] Sending batch '${payload.subject}' to ${payload.recipients.length} recipients`)

    const messageVersions = payload.recipients.map(recipient => ({
      to: [{ email: recipient.email, name: recipient.name }],
      // Start with global subject/content, but can be overridden here if needed per recipient
    }))

    const body = {
      sender: {
        name: SENDER_NAME,
        email: SENDER_EMAIL,
      },
      subject: payload.subject,
      htmlContent: payload.htmlContent,
      messageVersions,
    }

    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Brevo Batch API Error: ${response.status} ${errorText}`)
    }

    const data = await response.json()
    console.log(`[Email] Batch sent successfully.`)

    return { success: true, messageId: data.messageIds?.[0] } // Returns array of IDs usually

  } catch (error: any) {
    console.error("[Email] Batch send failed:", error)
    return { success: false, error: error.message }
  }
}

