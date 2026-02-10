import { createClient } from "@supabase/supabase-js"
import { Resend } from 'resend'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Email Provider Configuration
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'brevo' // 'brevo' or 'resend'
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"
const BREVO_API_KEY = process.env.BREVO_API_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const SENDER_NAME = process.env.EMAIL_SENDER_NAME || "DataGod"
const SENDER_EMAIL = process.env.EMAIL_SENDER_ADDRESS || "noreply@datagod.com"
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://datagod.store"

// Initialize Resend client (only if configured)
let resendClient: Resend | null = null
if (RESEND_API_KEY) {
  resendClient = new Resend(RESEND_API_KEY)
}

export interface EmailRecipient {
  email: string
  name?: string
}

export interface EmailPayload {
  to: EmailRecipient[]
  subject: string
  htmlContent: string
  textContent?: string
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
 * Premium HTML Template Wrapper
 * Design: Dark Grid Header, Gold Accents, Clean White Card
 */
function wrapHtml(content: string, title: string, showHero: boolean = false): string {
  const logoUrl = `${APP_URL}/apple-touch-icon.png`

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
        
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, Arial, sans-serif; line-height: 1.6; color: #374151; margin: 0; padding: 0; background-color: #f3f4f6; }
        .wrapper { background-color: #f3f4f6; padding: 20px 0; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        
        /* Premium Header */
        .header { background-color: #0f172a; color: #ffffff; padding: 30px 20px; text-align: center; background-image: radial-gradient(#1e293b 1px, #0f172a 1px); background-size: 20px 20px; }
        .brand-logo { width: 48px; height: 48px; border-radius: 8px; margin-bottom: 12px; }
        .brand-name { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; color: #fbbf24; margin: 0; }
        .header-title { font-size: 24px; font-weight: 700; margin: 10px 0 5px 0; color: #ffffff; }
        
        /* Content Body */
        .content { padding: 30px 25px; }
        
        /* Buttons */
        .button-primary { display: inline-block; background: linear-gradient(135deg, #fbbf24 0%, #d97706 100%); color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-top: 20px; width: 100%; text-align: center; box-sizing: border-box; box-shadow: 0 4px 6px rgba(251, 191, 36, 0.3); }
        .button-secondary { display: inline-block; background-color: #f3f4f6; color: #4b5563; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; margin-top: 10px; width: 100%; text-align: center; box-sizing: border-box; }
        
        /* Text Styles */
        h1, h2, h3 { color: #111827; margin-top: 0; }
        p { margin-bottom: 15px; font-size: 15px; color: #4b5563; }
        
        /* Cards & Tables */
        .info-card { background-color: #f9fafb; border-radius: 8px; padding: 20px; border: 1px solid #e5e7eb; margin: 20px 0; }
        .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb;font-size: 14px; }
        .info-row:last-child { border-bottom: none; }
        .info-label { color: #6b7280; font-weight: 500; }
        .info-value { color: #111827; font-weight: 600; text-align: right; }
        .info-value.highlight { color: #059669; font-weight: 700; }
        
        /* Status Badges */
        .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
        .badge-success { background-color: #dcfce7; color: #166534; }
        .badge-warning { background-color: #fef3c7; color: #92400e; }
        .badge-error { background-color: #fee2e2; color: #991b1b; }

        /* Footer */
        .footer { background-color: #f9fafb; padding: 30px 20px; text-align: center; border-top: 1px solid #e5e7eb; }
        .footer-links { margin-bottom: 20px; }
        .footer-link { color: #6b7280; text-decoration: none; font-size: 12px; margin: 0 8px; font-weight: 500; }
        .footer-text { font-size: 12px; color: #9ca3af; margin: 5px 0; line-height: 1.5; }
        .footer-contact { color: #2563eb; text-decoration: none; font-weight: 500; }
        
        /* Utilities */
        .text-center { text-align: center; }
        .mt-4 { margin-top: 16px; }
        .mb-2 { margin-bottom: 8px; }
        .icon-large { font-size: 32px; margin-bottom: 10px; display: block; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <!-- Premium Header -->
          <div class="header">
            <!-- Logo Section -->
            <img src="${logoUrl}" alt="Logo" class="brand-logo" onerror="this.style.display='none'">
            <p class="brand-name">${SENDER_NAME}</p>
            
            ${showHero ? `<h1 class="header-title">${title}</h1>` : ''}
          </div>

          <!-- Main Content -->
          <div class="content">
            ${content}
          </div>

          <!-- Footer -->
          <div class="footer">
            <div class="footer-links">
              <a href="${APP_URL}" class="footer-link">Website</a>
              <a href="${APP_URL}/dashboard" class="footer-link">Dashboard</a>
              <a href="${APP_URL}/support" class="footer-link">Support</a>
            </div>
            <p class="footer-text">
              Questions? Reply to this email or contact us at<br>
              <a href="mailto:${SENDER_EMAIL}" class="footer-contact">${SENDER_EMAIL}</a>
            </p>
            <p class="footer-text">
              &copy; ${new Date().getFullYear()} ${SENDER_NAME}. All rights reserved.<br>
              Premium Data Reseller Platform
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `
}

export const EmailTemplates = {
  welcomeEmail: (firstName: string) => ({
    subject: `Welcome to ${SENDER_NAME}!`,
    html: wrapHtml(`
      <div class="text-center">
        <span class="icon-large">👋</span>
        <h2>Welcome to the Family!</h2>
        <p>Hi ${firstName},</p>
        <p>Thank you for joining <strong>${SENDER_NAME}</strong>. We are thrilled to have you on board.</p>
      </div>
      
      <div class="info-card">
        <h3>What you can do now:</h3>
        <p>🚀 Purchase affordable data bundles</p>
        <p>💰 Fund your wallet instantly</p>
        <p>🏪 Apply to become a shop owner</p>
      </div>

      <a href="${APP_URL}/dashboard" class="button-primary">Go to Dashboard</a>
    `, "Welcome Onboard", false),
  }),

  walletTopUpSuccess: (amount: string, balance: string, ref: string) => ({
    subject: `Top-up Successful: GHS ${amount}`,
    html: wrapHtml(`
      <div class="text-center">
        <span class="icon-large">✅</span>
        <h2>Wallet Funded!</h2>
        <p>Your wallet has been successfully credited.</p>
      </div>

      <div class="info-card">
        <div class="info-row">
          <span class="info-label">Amount Credited</span>
          <span class="info-value highlight">GHS ${amount}</span>
        </div>
        <div class="info-row">
          <span class="info-label">New Balance</span>
          <span class="info-value">GHS ${balance}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Reference</span>
          <span class="info-value">${ref}</span>
        </div>
      </div>

      <a href="${APP_URL}/dashboard/wallet" class="button-primary">View Wallet</a>
    `, "Payment Received", true),
  }),

  walletTopUpInitiated: (amount: string, ref: string) => ({
    subject: "Wallet Top-up Initiated",
    html: wrapHtml(`
       <div class="text-center">
        <span class="icon-large">⏳</span>
        <h2>Processing Top-up</h2>
        <p>We have received your request to top up.</p>
      </div>
      <div class="info-card">
        <div class="info-row">
          <span class="info-label">Amount</span>
          <span class="info-value">GHS ${amount}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Reference</span>
          <span class="info-value">${ref}</span>
        </div>
      </div>
    `, "Processing Transaction", true),
  }),

  walletTopUpFailed: (amount: string, ref: string) => ({
    subject: "Top-up Failed",
    html: wrapHtml(`
      <div class="text-center">
        <span class="icon-large">❌</span>
        <h2>Transaction Failed</h2>
        <p>We could not complete your top-up request.</p>
      </div>
      <div class="info-card">
         <div class="info-row">
          <span class="info-label">Amount</span>
          <span class="info-value">GHS ${amount}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Reference</span>
          <span class="info-value">${ref}</span>
        </div>
      </div>
      <p>If you were debited, please contact support.</p>
    `, "Failed Transaction", true),
  }),

  orderCreated: (orderId: string, network: string, volume: string, amount: string) => ({
    subject: `Order Confirmed - ${network} ${volume}GB`,
    html: wrapHtml(`
      <div class="text-center">
        <span class="icon-large">📦</span>
        <h2>Order Placed Successfully!</h2>
        <span class="badge badge-warning">Processing</span>
        <p class="mt-4">Your order is being processed.</p>
      </div>

      <div class="info-card">
        <h3 style="font-size: 16px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 15px;">Order Details</h3>
        <div class="info-row">
          <span class="info-label">Order ID</span>
          <span class="info-value">${orderId}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Network</span>
          <span class="info-value">${network}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Package</span>
          <span class="info-value">${volume}GB</span>
        </div>
        <div class="info-row">
          <span class="info-label">Amount Paid</span>
          <span class="info-value highlight">GHS ${amount}</span>
        </div>
      </div>

      <a href="${APP_URL}/dashboard/my-orders" class="button-primary">Track Your Order</a>
    `, "Order Confirmation", true),
  }),

  orderPaymentConfirmed: (orderId: string, network: string, volume: string, amount: string) => ({
    subject: `Payment Confirmed: Order #${orderId}`,
    html: wrapHtml(`
      <div class="text-center">
        <span class="icon-large">✅</span>
        <h2>Payment Received</h2>
        <p>We are now processing your data bundle.</p>
      </div>

      <div class="info-card">
        <div class="info-row">
          <span class="info-label">Order ID</span>
          <span class="info-value">${orderId}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Package</span>
          <span class="info-value">${network} ${volume}GB</span>
        </div>
        <div class="info-row">
          <span class="info-label">Amount</span>
          <span class="info-value highlight">GHS ${amount}</span>
        </div>
      </div>
      
      <a href="${APP_URL}/dashboard/my-orders" class="button-primary">View Status</a>
    `, "Payment Success", true),
  }),

  orderDelivered: (orderId: string, network: string, volume: string) => ({
    subject: `✓ Order Delivered: ${network} ${volume}GB`,
    html: wrapHtml(`
      <div class="text-center">
        <span class="icon-large">🚀</span>
        <h2>Order Delivered!</h2>
        <span class="badge badge-success">Completed</span>
        <p class="mt-4">Your data bundle has been sent to your phone.</p>
      </div>

      <div class="info-card">
        <div class="info-row">
          <span class="info-label">Order ID</span>
          <span class="info-value">${orderId}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Package</span>
          <span class="info-value">${network} ${volume}GB</span>
        </div>
      </div>

      <a href="${APP_URL}/dashboard/my-orders" class="button-secondary">Buy Again</a>
    `, "Delivery Success", true),
  }),

  orderFailed: (orderId: string, reason: string) => ({
    subject: `Order Failed: #${orderId}`,
    html: wrapHtml(`
      <div class="text-center">
        <span class="icon-large">❌</span>
        <h2>Order Failed</h2>
        <span class="badge badge-error">Refunded</span>
        <p class="mt-4">We could not complete your request.</p>
      </div>

      <div class="info-card">
        <div class="info-row">
          <span class="info-label">Order ID</span>
          <span class="info-value">${orderId}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Reason</span>
          <span class="info-value">${reason}</span>
        </div>
      </div>
      <p>Funds have been refunded to your wallet.</p>
    `, "Order Failed", true),
  }),

  // Legacy Support for other templates (simplified to fit new style)
  withdrawalApproved: (amount: string, ref: string) => ({
    subject: "Withdrawal Approved",
    html: wrapHtml(`
      <div class="text-center"><h2>Withdrawal Processed</h2></div>
       <div class="info-card">
        <div class="info-row"><span class="info-label">Amount</span><span class="info-value">GHS ${amount}</span></div>
        <div class="info-row"><span class="info-label">Reference</span><span class="info-value">${ref}</span></div>
      </div>
    `, "Withdrawal Approved", true),
  }),

  withdrawalRejected: (amount: string, reason?: string) => ({
    subject: "Withdrawal Rejected",
    html: wrapHtml(`
      <div class="text-center"><h2 style="color:#ef4444">Withdrawal Rejected</h2></div>
      <p>Your request for GHS ${amount} was rejected.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
    `, "Withdrawal Status", true),
  }),

  shopApproved: (shopName: string, shopId: string) => ({
    subject: "Shop Approved!",
    html: wrapHtml(`
      <div class="text-center">
          <span class="icon-large">🎉</span>
          <h2>Shop Approved!</h2>
          <p>Your shop "<strong>${shopName}</strong>" is now live.</p>
      </div>
      <a href="${APP_URL}/dashboard/shop" class="button-primary">Manage Shop</a>
    `, "Shop Approved", true),
  }),

  shopRejected: (shopName: string, shopId: string, reason?: string) => ({
    subject: "Shop Application Update",
    html: wrapHtml(`
      <h2>Application Status</h2>
      <p>Your shop "${shopName}" was not approved.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
    `, "Shop Status", true),
  }),

  // Admin Alerts - Simplified
  fulfillmentFailed: (orderId: string, phone: string, network: string, sizeGb: string, reason: string) => ({
    subject: `[ALERT] Fulfillment Failed: #${orderId}`,
    html: wrapHtml(`
      <h2 style="color:#ef4444">Fulfillment Failed</h2>
       <div class="info-card">
        <div class="info-row"><span class="info-label">Order</span><span class="info-value">${orderId}</span></div>
        <div class="info-row"><span class="info-label">Phone</span><span class="info-value">${phone}</span></div>
        <div class="info-row"><span class="info-label">Package</span><span class="info-value">${network} ${sizeGb}GB</span></div>
        <div class="info-row"><span class="info-label">Reason</span><span class="info-value text-red-600">${reason}</span></div>
      </div>
       <a href="${APP_URL}/admin/orders" class="button-primary">View in Admin</a>
    `, "Admin Alert", true),
  }),

  priceManipulationDetected: (phone: string, clientPrice: string, actualPrice: string, network: string, volume: string) => ({
    subject: `[FRAUD] Price Manipulation Detected`,
    html: wrapHtml(`
      <h2 style="color:#ef4444">FRAUD ALERT</h2>
      <p>Price manipulation detected.</p>
       <div class="info-card">
        <div class="info-row"><span class="info-label">User</span><span class="info-value">${phone}</span></div>
        <div class="info-row"><span class="info-label">Difference</span><span class="info-value">GHS ${clientPrice} vs ${actualPrice}</span></div>
      </div>
    `, "Security Alert", true),
  }),

  paymentMismatchDetected: (reference: string, paidAmount: string, expectedAmount: string) => ({
    subject: `[ALERT] Payment Mismatch`,
    html: wrapHtml(`
      <h2 style="color:#f59e0b">Payment Warning</h2>
       <div class="info-card">
        <div class="info-row"><span class="info-label">Ref</span><span class="info-value">${reference}</span></div>
        <div class="info-row"><span class="info-label">Paid</span><span class="info-value">GHS ${paidAmount}</span></div>
        <div class="info-row"><span class="info-label">Expected</span><span class="info-value">GHS ${expectedAmount}</span></div>
      </div>
    `, "Payment Alert", true),
  }),

  subAgentInvitation: (shopName: string, inviteUrl: string, expiryDate: string) => ({
    subject: `You're invited to join ${shopName}!`,
    html: wrapHtml(`
      <div class="text-center">
        <span class="icon-large">🤝</span>
        <h2>Partner Invitation</h2>
        <p><strong>${shopName}</strong> has invited you to become a sub-agent.</p>
      </div>

      <div class="info-card">
        <h3>Why join?</h3>
        <p>🚀 Sell data bundles at wholesale prices</p>
        <p>💰 Earn profit on every sale</p>
        <p>🏪 Build your own reseller business</p>
      </div>
      
      <p class="text-center text-sm text-gray-500">This invite expires on ${expiryDate}</p>

      <a href="${inviteUrl}" class="button-primary">Accept Invitation</a>
    `, "Invitation", true),
  }),

  subscriptionExpiry1Day: (planName: string, expiryDate: string) => ({
    subject: "Subscription Expiring Soon",
    html: wrapHtml(`
      <h2>Renew Your Subscription</h2>
      <p>Your <strong>${planName}</strong> plan expires in 24 hours.</p>
      <a href="${APP_URL}/dashboard/subscription" class="button-primary">Renew Now</a>
    `, "Subscription Alert", true),
  }),

  subscriptionExpiry12Hours: (planName: string, expiryDate: string) => ({
    subject: "Subscription Expiring in 12h",
    html: wrapHtml(`
      <h2>Don't lose your benefits!</h2>
      <p>Your <strong>${planName}</strong> plan expires in 12 hours.</p>
       <a href="${APP_URL}/dashboard/subscription" class="button-primary">Renew Now</a>
    `, "Subscription Alert", true),
  }),

  subscriptionExpiry6Hours: (planName: string, expiryDate: string) => ({
    subject: "Urgent: Expires in 6 Hours",
    html: wrapHtml(`
      <h2 style="color:#ef4444">Urgent Warning</h2>
      <p>Your <strong>${planName}</strong> plan expires in 6 hours.</p>
       <a href="${APP_URL}/dashboard/subscription" class="button-primary">Renew Now</a>
    `, "Subscription Alert", true),
  }),

  subscriptionExpiry1Hour: (planName: string, expiryDate: string) => ({
    subject: "Final Call: Expires in 1 Hour",
    html: wrapHtml(`
      <h2 style="color:#ef4444">Final Call</h2>
      <p>Your <strong>${planName}</strong> plan expires in 1 Hour!</p>
       <a href="${APP_URL}/dashboard/subscription" class="button-primary">Renew Now</a>
    `, "Subscription Alert", true),
  }),
}

/**
 * Send email via Brevo
 */
async function sendEmailViaBrevo(payload: EmailPayload): Promise<{ success: boolean; messageId?: string; error?: string; provider?: string }> {
  if (!BREVO_API_KEY) {
    console.warn("[Email] BREVO_API_KEY is missing. Email skipped:", payload.subject)
    return { success: false, error: "Brevo API key not configured" }
  }

  try {
    console.log(`[Email] Sending via Brevo '${payload.subject}' to ${payload.to.length} recipient(s)`)

    const textContent = payload.textContent || payload.htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

    const body = {
      sender: {
        name: SENDER_NAME,
        email: SENDER_EMAIL,
      },
      to: payload.to,
      subject: payload.subject,
      htmlContent: payload.htmlContent,
      textContent: textContent,
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
      console.error(`[Email] Brevo API Failed: ${response.status}`, errorText)
      throw new Error(`Brevo API Error: ${response.status} ${errorText}`)
    }

    const data: BrevoResponse = await response.json()
    console.log(`[Email] ✓ Brevo sent successfully. ID: ${data.messageId}`)

    if (payload.userId) {
      await logEmail(payload, "sent", data.messageId)
    }

    return { success: true, messageId: data.messageId, provider: 'brevo' }

  } catch (error: any) {
    console.error("[Email] Brevo send failed:", error)

    if (payload.userId) {
      await logEmail(payload, "failed", undefined, error.message)
    }

    return { success: false, error: error.message, provider: 'brevo' }
  }
}

/**
 * Send email via Resend
 */
async function sendEmailViaResend(payload: EmailPayload): Promise<{ success: boolean; messageId?: string; error?: string; provider?: string }> {
  if (!resendClient || !RESEND_API_KEY) {
    console.warn("[Email] RESEND_API_KEY is missing. Email skipped:", payload.subject)
    return { success: false, error: "Resend API key not configured" }
  }

  try {
    console.log(`[Email] Sending via Resend '${payload.subject}' to ${payload.to.length} recipient(s)`)

    const textContent = payload.textContent || payload.htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

    const { data, error } = await resendClient.emails.send({
      from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
      to: payload.to.map(r => r.email),
      subject: payload.subject,
      html: payload.htmlContent,
      text: textContent,
    })

    if (error) {
      throw new Error(error.message)
    }

    const messageId = data?.id || 'unknown'
    console.log(`[Email] ✓ Resend sent successfully. ID: ${messageId}`)

    if (payload.userId) {
      await logEmail(payload, "sent", messageId)
    }

    return { success: true, messageId, provider: 'resend' }

  } catch (error: any) {
    console.error("[Email] Resend send failed:", error)

    if (payload.userId) {
      await logEmail(payload, "failed", undefined, error.message)
    }

    return { success: false, error: error.message, provider: 'resend' }
  }
}

/**
 * Router function - sends email using configured provider
 */
export async function sendEmail(payload: EmailPayload): Promise<{ success: boolean; messageId?: string; error?: string; provider?: string }> {
  console.log(`[Email] Provider: ${EMAIL_PROVIDER}`)

  // Route to the appropriate provider
  if (EMAIL_PROVIDER === 'resend') {
    return sendEmailViaResend(payload)
  } else {
    return sendEmailViaBrevo(payload)
  }
}


async function logEmail(payload: EmailPayload, status: "sent" | "failed", messageId?: string, errorMessage?: string) {
  try {
    console.log(`[Email] Logging to DB skipped (table not created yet). Status: ${status}`)
  } catch (e) {
    console.error("[Email] Failed to log email:", e)
  }
}

export async function notifyAdmins(subject: string, htmlContent: string): Promise<void> {
  try {
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

export async function sendBatchEmails(payload: BatchEmailPayload): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!BREVO_API_KEY) {
    console.warn("[Email] BREVO_API_KEY is missing. Batch email skipped.")
    return { success: false, error: "Configuration missing" }
  }

  try {
    console.log(`[Email] Sending batch '${payload.subject}' to ${payload.recipients.length} recipients`)

    const messageVersions = payload.recipients.map(recipient => ({
      to: [{ email: recipient.email, name: recipient.name }],
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

    return { success: true, messageId: data.messageIds?.[0] }

  } catch (error: any) {
    console.error("[Email] Batch send failed:", error)
    return { success: false, error: error.message }
  }
}

