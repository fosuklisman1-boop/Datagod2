import axios from 'axios'
import { createClient } from '@supabase/supabase-js'
import { notifyAdmins as sendAdminEmail } from './email-service'
import { getRoutingConfig } from '@/lib/sms/routing'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// SMS Provider Configuration
const SMS_PROVIDER = process.env.SMS_PROVIDER || 'moolre' // 'moolre', 'brevo', or 'mnotify'
const BREVO_API_KEY = process.env.BREVO_API_KEY
const BREVO_SMS_SENDER = process.env.BREVO_SMS_SENDER || process.env.EMAIL_SENDER_NAME || 'DTGOD'
const MOOLRE_API_KEY = process.env.MOOLRE_API_KEY
const MOOLRE_SENDER_ID = process.env.MOOLRE_SENDER_ID || 'CLINGDTGOD'
const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY
const MNOTIFY_SENDER_ID = process.env.MNOTIFY_SENDER_ID || 'MDATAGH'

// State for SMS exhaustion fallback
let isSmsExhausted = false
let lastExhaustionCheck = 0
const EXHAUSTION_CACHE_MS = 60 * 60 * 1000 // 1 hour

interface SMSPayload {
  phone: string
  message: string
  type: string
  reference?: string
  userId?: string
  skipLogging?: boolean // NEW: Prevent duplicate logs during retries
  senderId?: string // chosen per-account Moolre sender ID; falls back to MOOLRE_SENDER_ID
}

// OTP/PIN codes must never be persisted in sms_logs — that table is readable by
// admins and (for rows with a matching user_id) by a user's own-logs RLS, so a
// stored code is one misconfiguration or one compromised admin away from leaking.
// Redact the body before logging for code-bearing messages; keep everything else
// intact for audit/debugging. Matches on type AND on the code template shape so a
// new code-bearing sender can't silently start logging plaintext codes.
const CODE_BEARING_TYPES = new Set(["phone_otp"])
function logSafeSmsBody(payload: SMSPayload): string {
  if (CODE_BEARING_TYPES.has(payload.type)) return "[OTP code redacted]"
  if (/Your code is\s*\d{4,8}/i.test(payload.message)) return "[OTP code redacted]"
  return payload.message
}

interface SendSMSResponse {
  success: boolean
  messageId?: string
  ref?: string // queryable tracking ref (Moolre delivery status)
  skipped?: boolean
  error?: string
  provider?: string
}

// Maps internal network identifiers to display color names
export const networkColor = (network: string): string => {
  const map: Record<string, string> = {
    mtn: "Yellow",
    telecel: "Red",
    "at ishare": "Blue",
    "at big time": "Blue Big",
    airteltigo: "Blue",
    airtel: "Blue",
    tigo: "Blue",
  }
  return map[network.toLowerCase()] ?? network
}

// SMS Templates
export const SMSTemplates = {
  walletTopUpInitiated: (amount: string, ref: string) =>
    `DTGOD: Your DTGOD-Wallet top-up of GH¢${amount} has been initiated. Reference: ${ref}. We are processing your request.`,

  walletTopUpSuccess: (amount: string, balance: string) =>
    `DTGOD: Your DTGOD-Wallet has been credited with GH¢${amount}. Available balance: GH¢${balance}. Thank you for topping up.`,

  walletTopUpFailed: (amount: string) =>
    `DTGOD: We were unable to process your DTGOD-Wallet top-up of GH¢${amount}. Please try again or contact our support team for assistance.`,

  // Wallet/dashboard order confirmation (no shop involved)
  orderPaymentConfirmed: (network: string, volume: string, phone: string) =>
    `You have successfully placed an order of ${networkColor(network)} ${volume}G.B to ${phone}. If delayed over 2 hours, contact support.`,

  // Phase 2 registration gate: order held while the number is activated.
  mtnRegistrationHold: (phone: string) =>
    `DTGOD: ${phone} is being activated for ${networkColor("MTN")} data service. Your order will be delivered automatically once activation completes (usually within a day).`,

  // Storefront order confirmation (shop name excluded from message)
  shopOrderConfirmed: (shopName: string, network: string, volume: string, phone: string, ownerPhone: string) =>
    `You have successfully placed an order of ${networkColor(network)} ${volume}G.B to ${phone}. If delayed over 2 hours, contact shop owner: ${ownerPhone}`,

  orderDelivered: (orderId: string, network: string, volume: string) =>
    `DTGOD: Order Delivered. Your ${networkColor(network)} ${volume}G.B (Ref: ${orderId}) has been successfully delivered. Thank you for choosing DTGOD.`,

  withdrawalApproved: (amount: string, ref: string) =>
    `DTGOD: Withdrawal Approved. Your withdrawal request of GH¢${amount} has been approved and will be transferred to your account shortly. Reference: ${ref}.`,

  withdrawalRejected: (amount: string) =>
    `DTGOD: Withdrawal Update. Your withdrawal request of GH¢${amount} could not be processed at this time. Please contact our support team for further assistance.`,

  verificationCode: (code: string) =>
    `DTGOD: Your code is ${code}. Valid for 10 minutes. Do not share it with anyone.`,

  passwordReset: (link: string) =>
    `DTGOD: A password reset was requested for your account. Use this link to proceed: ${link}. Valid for 1 hour. If you did not request this, please ignore this message.`,

  // Admin notifications
  fulfillmentFailed: (orderId: string, phone: string, network: string, sizeGb: string, reason: string) =>
    `[ADMIN] Fulfillment FAILED! Order: ${orderId.substring(0, 8)} | ${phone} | ${networkColor(network)} ${sizeGb}G.B | Reason: ${reason.substring(0, 50)}`,

  // Price manipulation alert
  priceManipulationDetected: (phone: string, clientPrice: string, actualPrice: string, network: string, volume: string) =>
    `[FRAUD ALERT] Price manipulation detected! Phone: ${phone} | Sent: GH¢${clientPrice} | Actual: GH¢${actualPrice} | ${networkColor(network)} ${volume}G.B`,

  // Payment mismatch alert
  paymentMismatchDetected: (reference: string, paidAmount: string, expectedAmount: string) =>
    `[FRAUD ALERT] Payment mismatch! Ref: ${reference} | Paid: GH¢${paidAmount} | Expected: GH¢${expectedAmount}`,

  // Admin credit/debit notifications to user
  adminCredited: (amount: string, balance: string) =>
    `DTGOD: Account Update. Your DTGOD-Wallet has been credited with GH¢${amount} by the administrator. Available balance: GH¢${balance}.`,

  adminDebited: (amount: string, balance: string) =>
    `DTGOD: Account Update. Your DTGOD-Wallet has been debited GH¢${amount} by the administrator. Available balance: GH¢${balance}. Contact support if you have any concerns.`,

  // Dealer subscription notifications
  subscriptionSuccess: (planName: string, endDate: string) =>
    `DTGOD: Subscription Activated. Your ${planName} plan is now active and valid until ${endDate}. Your dealer privileges have been unlocked. Thank you for your commitment.`,

  subscriptionExpiry1Day: (planName: string, endDate: string) =>
    `DTGOD: Subscription Reminder. Your ${planName} plan expires in 1 day on ${endDate}. Renew now to maintain uninterrupted dealer access.`,

  subscriptionExpiry12Hours: (planName: string, endDate: string) =>
    `DTGOD: Subscription Alert. Your ${planName} plan expires in 12 hours on ${endDate}. Please renew promptly to avoid any interruption to your services.`,

  subscriptionExpiry6Hours: (planName: string, endDate: string) =>
    `DTGOD: Urgent - Subscription Expiring. Your ${planName} plan expires in 6 hours on ${endDate}. Immediate renewal is required to avoid loss of access.`,

  subscriptionExpiry1Hour: (planName: string, endDate: string) =>
    `DTGOD: Final Notice. Your ${planName} plan expires in 1 hour on ${endDate}. Please renew immediately to avoid suspension of your dealer account.`,

  userSuspended: (reason?: string) =>
    `DTGOD: Account Suspended. Your DTGOD account has been suspended.${reason ? ` Reason: ${reason}.` : ""} Please contact our support team if you believe this is an error.`,

  userUnsuspended: () =>
    `DTGOD: Account Restored. Your DTGOD account has been reactivated. You may now log in to your dashboard and resume your activities.`,

  // Airtime specific notifications (shop name excluded from message)
  airtimeBeneficiaryNotification: (shopName: string, network: string, amount: string, phone: string, ref: string) =>
    `Your airtime purchase has been processed. GH¢${amount} of ${networkColor(network)} airtime has been sent to ${phone}. Reference: ${ref}. Thank you for your order.`,

  adminAirtimeOrderNotification: (source: string, phone: string, amount: string, network: string) =>
    `[NEW ORDER] Airtime\nSource: ${source}\nRecipient: ${phone}\nAmount: GH¢${amount}\nNetwork: ${networkColor(network)}`,

  adminAirtimeManualRequired: (ref: string, network: string, phone: string, amount: string) =>
    `[AIRTIME] Manual fulfillment needed\nRef: ${ref}\nNetwork: ${networkColor(network)}\nRecipient: ${phone}\nAmount: GH¢${amount}`,

  adminAirtimeDigiwapyFailed: (ref: string, network: string, phone: string, amount: string, reason: string) =>
    `[AIRTIME FAILED] Digiwapy error\nRef: ${ref}\nNetwork: ${networkColor(network)}\nRecipient: ${phone}\nAmount: GH¢${amount}\nReason: ${reason}`,

  // AFA registration confirmation
  afaRegistration: (fullName: string, orderCode: string, amount: string) =>
    `DTGOD: Your AFA registration for ${fullName} (Ref: ${orderCode}) has been received. Amount: GH¢${amount}. You will be contacted once the registration is processed.`,

  // AFA registration completion
  afaCompleted: (fullName: string, orderCode: string) =>
    `DTGOD: Good news! Your AFA registration for ${fullName} (Ref: ${orderCode}) has been completed successfully. Thank you for registering with us.`,

  // Results checker voucher delivery
  resultsCheckerDelivery: (examBoard: string, ref: string, pins: Array<{ pin: string; serial_number: string | null }>) => {
    // Official WAEC portal differs by board: BECE → e-results, WASSCE/NOVDEC → WAEC Direct.
    const portal = examBoard?.toUpperCase() === "BECE" ? "https://eresults.waecgh.org" : "https://ghana.waecdirect.org"
    return `Your ${pins.length}x ${examBoard} voucher${pins.length > 1 ? "s" : ""}:\n\n` +
      pins.map(p => `PIN: ${p.pin}\nSerial: ${p.serial_number ?? "N/A"}`).join("\n\n") +
      `\n\nCheck your ${examBoard} results at ${portal}`
  },

  // Sub-agent invitation
  subAgentInvitation: (inviteUrl: string) =>
    `DTGOD: You have been invited to become a sub-agent! Join here: ${inviteUrl} (Expires in 7 days)`,

  // USSD order confirmed — sent to recipient phone
  ussdOrderConfirmed: (packageSize: string, network: string, channelLink?: string) => {
    const colour = networkColor(network)
    // package_size sometimes embeds the carrier name (e.g. "MTN 5GB"); swap it for
    // the colour alias so the real network name never appears in the message.
    const escaped = network.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const sized = network
      ? packageSize.replace(new RegExp(escaped, "ig"), colour).replace(/\s{2,}/g, " ").trim()
      : packageSize
    // Append the colour separately only if it isn't already present in the size text.
    const suffix = sized.toLowerCase().includes(colour.toLowerCase()) ? "" : ` ${colour}`
    return `DTGOD: Your ${sized}${suffix} is on its way! It will reflect in a few minutes.` +
      (channelLink ? `\nJoin our channel: ${channelLink}` : ``)
  },

  // USSD payment confirmed — sent to dialing/paying phone
  ussdPaymentConfirmed: (packageSize: string, network: string, maskedPhone: string) =>
    `DTGOD: ${packageSize.replace(/GB/gi, 'G.B')} ${networkColor(network)} sent to ${maskedPhone}. Thank you!`,

  // OTP required — sent after session ends so customer knows to redial
  ussdOtpRequired: () =>
    `DTGOD: As a first-time user, your purchase requires a one-time PIN to verify your number. Redial the USSD code and enter the PIN sent to your phone to complete your order. You have 10 minutes.`,

  // USSD AFA registration payment received
  ussdAfaPaymentReceived: () =>
    `DTGOD: Your AFA registration payment has been received and is being processed. Registration takes 12-24hrs to reflect. Thank you!`,

  // USSD airtime payment received — airtime is fulfilled manually, so do not
  // claim it has already landed.
  ussdAirtimePaymentReceived: (amount: string, network: string, phone: string) =>
    `DTGOD: Payment received. GH¢${amount} ${networkColor(network)} airtime for ${phone} is being processed and will reflect shortly. Thank you!`,

  // Wallet topped up (used in webhook and payment-cleanup flows)
  walletToppedUp: (firstName: string, amount: string, balance: string) =>
    `DTGOD: Hi ${firstName}, your DTGOD-Wallet has been topped up by GH¢${amount}. New balance: GH¢${balance}.`,

  // Dealer account upgraded
  dealerUpgraded: () =>
    `DTGOD: Congratulations! Your account has been upgraded to Dealer. Enjoy wholesale prices!`,

  // Airtime order failed — refund issued
  airtimeOrderFailed: (refCode: string, amount: string) =>
    `DTGOD: Your airtime order ${refCode} failed. GH¢${amount} has been refunded to your DTGOD-Wallet.`,

  // Airtime order delivered
  airtimeOrderDelivered: (amount: string, network: string, phone: string, ref: string) =>
    `DTGOD: GH¢${amount} ${networkColor(network)} airtime has been sent to ${phone}. Ref: ${ref}.`,
}

/**
 * Normalize phone number to Moolre format
 * Accepts: +233XXXXXXXXX, 0XXXXXXXXX, 233XXXXXXXXX
 * Returns: +233XXXXXXXXX
 */
function normalizePhoneNumber(phone: string): string {
  phone = phone.replace(/[\s\-\(\)]/g, '')

  if (phone.startsWith('0')) {
    phone = '+233' + phone.substring(1)
  } else if (phone.startsWith('233') && !phone.startsWith('+233')) {
    phone = '+' + phone
  } else if (!phone.startsWith('+')) {
    phone = '+233' + phone
  }

  return phone
}

/**
 * Send SMS via Brevo API (formerly SendinBlue)
 */
async function sendSMSViaBrevo(payload: SMSPayload): Promise<SendSMSResponse> {
  console.log('[SMS] Sending via Brevo to:', payload.phone)

  if (!BREVO_API_KEY) {
    console.warn('[SMS] Brevo API key not configured')
    return { success: false, error: 'Brevo API key not configured' }
  }

  try {
    const normalizedPhone = normalizePhoneNumber(payload.phone)
    // Remove + for Brevo (expects format like 33680065433)
    const brevoPhone = normalizedPhone.replace('+', '')

    const requestBody = {
      sender: BREVO_SMS_SENDER.substring(0, 11), // Max 11 chars for alphanumeric
      recipient: brevoPhone,
      content: payload.message,
      type: 'transactional', // Use 'transactional' for non-marketing SMS
      tag: payload.type,
      unicodeEnabled: true,
    }

    console.log('[SMS] Brevo request:', {
      sender: requestBody.sender,
      recipient: brevoPhone,
      type: requestBody.type,
      tag: payload.type,
      messageLength: payload.message.length,
    })

    const response = await axios.post(
      'https://api.brevo.com/v3/transactionalSMS/sms',
      requestBody,
      {
        headers: {
          'api-key': BREVO_API_KEY,
          'content-type': 'application/json',
          'accept': 'application/json',
        },
      }
    )

    const messageId = response.data.messageId?.toString() || 'unknown'
    console.log('[SMS] ✓ Brevo Success - Message ID:', messageId)

    // Log to database (always — user_id is nullable)
    if (!payload.skipLogging) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId || null,
          phone_number: payload.phone,
          message: logSafeSmsBody(payload),
          message_type: payload.type,
          reference_id: payload.reference || null,
          moolre_message_id: messageId, // Reuse column for Brevo message ID
          provider: 'brevo',
          status: 'sent',
        })
      } catch (logError) {
        console.warn('[SMS] Failed to log SMS:', logError)
      }
    }

    return {
      success: true,
      messageId,
      provider: 'brevo',
    }
  } catch (error) {
    console.error('[SMS] Brevo Error:', error)

    let errorMessage = 'Failed to send SMS via Brevo'
    if (axios.isAxiosError(error)) {
      errorMessage = error.response?.data?.message || error.message
      const status = error.response?.status

      console.error('[SMS] Brevo API Error:', {
        status,
        data: error.response?.data,
      })

      // Handle insufficient credits (402)
      if (status === 402 || errorMessage.toLowerCase().includes('credit') || errorMessage.toLowerCase().includes('balance')) {
        console.warn('[SMS] 🚨 SMS Credits Exhausted (402). Setting exhaustion flag.')
        isSmsExhausted = true
        lastExhaustionCheck = Date.now()
      }
    }

    // Log failed SMS (always — user_id is nullable)
    if (!payload.skipLogging) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId || null,
          phone_number: payload.phone,
          message: logSafeSmsBody(payload),
          message_type: payload.type,
          reference_id: payload.reference || null,
          provider: 'brevo',
          status: 'failed',
          error_message: errorMessage,
        })
      } catch (logError) {
        console.warn('[SMS] Failed to log failed SMS:', logError)
      }
    }

    return {
      success: false,
      error: errorMessage,
      provider: 'brevo',
    }
  }
}

/**
 * Send SMS via Moolre API
 */
async function sendSMSViaMoolre(payload: SMSPayload): Promise<SendSMSResponse> {
  console.log('[SMS] Sending via Moolre to:', payload.phone)

  if (!MOOLRE_API_KEY) {
    console.warn('[SMS] Moolre API key not configured')
    return { success: false, error: 'Moolre API key not configured' }
  }

  try {
    const normalizedPhone = normalizePhoneNumber(payload.phone)

    // Unique tracking ref. Moolre's send response carries NO message ID
    // (data:null), so this ref is our only handle to later query delivery status
    // via /open/sms/query. We store it on sms_logs.moolre_message_id.
    const trackingRef = `dg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    const queryParams = new URLSearchParams({
      type: '1',
      // Per-account sender ID when the caller supplied one (a tenant's active,
      // Moolre-registered ID); otherwise the platform default.
      senderid: payload.senderId || MOOLRE_SENDER_ID,
      recipient: normalizedPhone,
      message: payload.message,
      ref: trackingRef,
    })

    const url = `https://api.moolre.com/open/sms/send?${queryParams.toString()}&X-API-VASKEY=${MOOLRE_API_KEY}`

    console.log('[SMS] Moolre request to:', payload.phone.substring(0, 6) + '***')

    const response = await axios.get(url)

    if (response.data.status !== 1) {
      throw new Error(`Moolre API Error: ${response.data.message || 'Unknown error'}`)
    }

    console.log('[SMS] ✓ Moolre accepted - tracking ref:', trackingRef)

    // Log EVERY send (user_id is nullable) so the delivery-sync cron can resolve
    // it via /open/sms/query. moolre_message_id holds the queryable tracking ref;
    // status starts at 'sent' (accepted) and the cron flips it to delivered/failed.
    if (!payload.skipLogging) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId || null,
          phone_number: payload.phone,
          message: logSafeSmsBody(payload),
          message_type: payload.type,
          reference_id: payload.reference || null,
          moolre_message_id: trackingRef,
          provider: 'moolre',
          status: 'sent',
        })
      } catch (logError) {
        console.warn('[SMS] Failed to log SMS:', logError)
      }
    }

    return {
      success: true,
      messageId: trackingRef,
      ref: trackingRef,
      provider: 'moolre',
    }
  } catch (error) {
    console.error('[SMS] Moolre Error:', error)

    let errorMessage = 'Failed to send SMS via Moolre'
    if (axios.isAxiosError(error)) {
      errorMessage = error.response?.data?.message || error.message
    }

    // Log failed SMS (always — surfaces OTP/send rejections in sms_logs)
    if (!payload.skipLogging) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId || null,
          phone_number: payload.phone,
          message: logSafeSmsBody(payload),
          message_type: payload.type,
          reference_id: payload.reference || null,
          provider: 'moolre',
          status: 'failed',
          error_message: errorMessage,
        })
      } catch (logError) {
        console.warn('[SMS] Failed to log failed SMS:', logError)
      }
    }

    return {
      success: false,
      error: errorMessage,
      provider: 'moolre',
    }
  }
}

/**
 * Query Moolre for the delivery status of previously-sent messages, keyed by the
 * tracking refs we attached at send time. POST /open/sms/query (type 5).
 * Returns ref -> status: 0 (Unknown) | 1 (Sent/in-route) | 2 (Delivered) | 3 (Failed).
 */
export async function queryMoolreDeliveryStatus(refs: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (!MOOLRE_API_KEY || refs.length === 0) return out
  try {
    const response = await axios.post(
      'https://api.moolre.com/open/sms/query',
      { type: 5, ref: refs },
      { headers: { 'X-API-VASKEY': MOOLRE_API_KEY, 'Content-Type': 'application/json' } }
    )
    const data = response.data?.data
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && item.ref != null) out[String(item.ref)] = Number(item.status)
      }
    }
  } catch (error) {
    console.error('[SMS] Moolre status query failed:', axios.isAxiosError(error) ? error.message : error)
  }
  return out
}

/**
 * Read the Moolre wholesale SMS credit balance (the single shared pool backing ALL
 * tenants' internal units). POST /open/sms/query (type 2) -> data.balance.
 * Fails CLOSED: returns 0 on any error, so callers treat the platform as un-fundable
 * and route credits to "pending" rather than over-crediting beyond real supply.
 */
export async function queryMoolreSmsBalance(): Promise<number> {
  if (!MOOLRE_API_KEY) return 0
  try {
    const response = await axios.post(
      'https://api.moolre.com/open/sms/query',
      { type: 2 },
      { headers: { 'X-API-VASKEY': MOOLRE_API_KEY, 'Content-Type': 'application/json' } }
    )
    return Number(response.data?.data?.balance ?? 0)
  } catch (error) {
    console.error('[SMS] Moolre balance query failed:', axios.isAxiosError(error) ? error.message : error)
    return 0
  }
}

/**
 * Send a BATCH of SMS in ONE Moolre call (POST /open/sms/send, type 1, messages[]).
 * Far faster than the per-recipient loop for campaigns — the whole batch is
 * accepted or rejected together (status 1 / code SMS01 = accepted). Per-recipient
 * delivery is tracked later via the refs (query type 5). Never throws.
 *
 * @param items     recipients with their (already prepared) message + a ref for tracking
 * @param senderId  the chosen sender ID; falls back to MOOLRE_SENDER_ID
 */
export async function sendSMSBulkViaMoolre(
  items: { recipient: string; message: string; ref?: string }[],
  senderId?: string
): Promise<{ ok: boolean; code?: string; message?: string }> {
  if (!MOOLRE_API_KEY) return { ok: false, message: 'Moolre API key not configured' }
  if (items.length === 0) return { ok: true }
  try {
    const messages = items.map((i) => ({
      recipient: normalizePhoneNumber(i.recipient),
      message: i.message,
      ...(i.ref ? { ref: i.ref } : {}),
    }))
    const response = await axios.post(
      'https://api.moolre.com/open/sms/send',
      { type: 1, senderid: (senderId || MOOLRE_SENDER_ID).substring(0, 11), messages },
      { headers: { 'X-API-VASKEY': MOOLRE_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
    )
    const ok = response.data?.status === 1 || response.data?.code === 'SMS01'
    return { ok, code: response.data?.code, message: response.data?.message }
  } catch (error) {
    console.error('[SMS] Moolre bulk send failed:', axios.isAxiosError(error) ? error.message : error)
    return { ok: false, message: axios.isAxiosError(error) ? error.message : 'Unknown error' }
  }
}

/**
 * Submit a sender-ID registration request to Moolre (type 3).
 * Integrators lack the "approve" permission (ASMQ09 constraint), so this only
 * registers the ID — Moolre staff approve it asynchronously. Success code is ASMQ12.
 * Returns { ok: boolean, message? } — never throws.
 */
export async function createMoolreSenderId(senderId: string): Promise<{ ok: boolean; message?: string }> {
  if (!MOOLRE_API_KEY) return { ok: false, message: 'Moolre API key not configured' }
  try {
    const response = await axios.post(
      'https://api.moolre.com/open/sms/query',
      { type: 3, senderids: [{ senderid: senderId }] },
      { headers: { 'X-API-VASKEY': MOOLRE_API_KEY, 'Content-Type': 'application/json' } }
    )
    const code = response.data?.code ?? response.data?.status
    const ok = code === 'ASMQ12' || response.data?.status === 1 || response.data?.success === true
    return { ok, message: response.data?.message ?? String(code ?? '') }
  } catch (error) {
    console.error('[SMS] Moolre createSenderId failed:', axios.isAxiosError(error) ? error.message : error)
    return { ok: false, message: axios.isAxiosError(error) ? error.message : 'Unknown error' }
  }
}

/**
 * Query Moolre for the approval status of a sender-ID (type 1).
 * Maps "Approved" (code ASMQ02) → 'active', "Rejected" (code ASMQ07) → 'rejected',
 * anything else → 'pending'. Fail-soft: returns pending on any error, never throws.
 */
export async function queryMoolreSenderIdStatus(senderId: string): Promise<{
  rawStatus: string
  localStatus: 'pending' | 'active' | 'rejected'
}> {
  if (!MOOLRE_API_KEY) return { rawStatus: 'no_api_key', localStatus: 'pending' }
  try {
    const response = await axios.post(
      'https://api.moolre.com/open/sms/query',
      { type: 1, senderid: senderId },
      { headers: { 'X-API-VASKEY': MOOLRE_API_KEY, 'Content-Type': 'application/json' } }
    )
    const rawStatus = response.data?.data?.status ?? response.data?.code ?? response.data?.status ?? 'unknown'
    const rawStr = String(rawStatus)
    const localStatus: 'pending' | 'active' | 'rejected' =
      rawStr === 'ASMQ02' || rawStr === 'Approved' ? 'active'
      : rawStr === 'ASMQ07' || rawStr === 'Rejected' ? 'rejected'
      : 'pending'
    return { rawStatus: rawStr, localStatus }
  } catch (error) {
    console.error('[SMS] Moolre querySenderIdStatus failed:', axios.isAxiosError(error) ? error.message : error)
    return { rawStatus: 'error', localStatus: 'pending' }
  }
}

/**
 * Normalize phone number to local Ghana format for mNotify
 * Accepts: +233XXXXXXXXX, 233XXXXXXXXX, 0XXXXXXXXX
 * Returns: 0XXXXXXXXX
 */
function normalizePhoneForMNotify(phone: string): string {
  phone = phone.replace(/[\s\-\(\)]/g, '')
  if (phone.startsWith('+233')) {
    phone = '0' + phone.substring(4)
  } else if (phone.startsWith('233')) {
    phone = '0' + phone.substring(3)
  } else if (!phone.startsWith('0')) {
    phone = '0' + phone
  }
  return phone
}

/**
 * Send SMS via mNotify Quick Bulk SMS API
 */
async function sendSMSViaMNotify(payload: SMSPayload): Promise<SendSMSResponse> {
  console.log('[SMS] Sending via mNotify to:', payload.phone)

  if (!MNOTIFY_API_KEY) {
    console.warn('[SMS] mNotify API key not configured')
    return { success: false, error: 'mNotify API key not configured' }
  }

  try {
    const localPhone = normalizePhoneForMNotify(payload.phone)

    const requestBody = {
      recipient: [localPhone],
      sender: MNOTIFY_SENDER_ID.substring(0, 11), // Max 11 chars
      message: payload.message,
      is_schedule: false,
      schedule_date: '',
    }

    const url = `https://api.mnotify.com/api/sms/quick?key=${MNOTIFY_API_KEY}`

    console.log('[SMS] mNotify request:', {
      sender: requestBody.sender,
      recipient: localPhone.substring(0, 6) + '***',
      messageLength: payload.message.length,
    })

    const response = await axios.post(url, requestBody, {
      headers: { 'Content-Type': 'application/json' },
    })

    if (response.data.status !== 'success') {
      throw new Error(`mNotify API Error: ${response.data.message || 'Unknown error'}`)
    }

    const messageId = response.data.summary?._id || 'unknown'
    console.log('[SMS] ✓ mNotify Success - Campaign ID:', messageId)

    // Log to database (always — user_id is nullable)
    if (!payload.skipLogging) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId || null,
          phone_number: payload.phone,
          message: logSafeSmsBody(payload),
          message_type: payload.type,
          reference_id: payload.reference || null,
          moolre_message_id: messageId, // Reuse column for mNotify campaign ID
          provider: 'mnotify',
          status: 'sent',
        })
      } catch (logError) {
        console.warn('[SMS] Failed to log SMS:', logError)
      }
    }

    return {
      success: true,
      messageId,
      provider: 'mnotify',
    }
  } catch (error) {
    console.error('[SMS] mNotify Error:', error)

    let errorMessage = 'Failed to send SMS via mNotify'
    if (axios.isAxiosError(error)) {
      errorMessage = error.response?.data?.message || error.message
      const status = error.response?.status

      console.error('[SMS] mNotify API Error:', {
        status,
        data: error.response?.data,
      })

      // Handle insufficient credits
      if (status === 402 || errorMessage.toLowerCase().includes('credit') || errorMessage.toLowerCase().includes('balance')) {
        console.warn('[SMS] 🚨 mNotify Credits Exhausted. Setting exhaustion flag.')
        isSmsExhausted = true
        lastExhaustionCheck = Date.now()
      }
    }

    // Log failed SMS (always — user_id is nullable)
    if (!payload.skipLogging) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId || null,
          phone_number: payload.phone,
          message: logSafeSmsBody(payload),
          message_type: payload.type,
          reference_id: payload.reference || null,
          provider: 'mnotify',
          status: 'failed',
          error_message: errorMessage,
        })
      } catch (logError) {
        console.warn('[SMS] Failed to log failed SMS:', logError)
      }
    }

    return {
      success: false,
      error: errorMessage,
      provider: 'mnotify',
    }
  }
}

const SMS_SENDERS: Record<string, (p: SMSPayload) => Promise<SendSMSResponse>> = {
  moolre: sendSMSViaMoolre,
  brevo: sendSMSViaBrevo,
  mnotify: sendSMSViaMNotify,
}

function isProviderConfigured(name: string): boolean {
  if (name === 'moolre') return !!MOOLRE_API_KEY
  if (name === 'brevo') return !!BREVO_API_KEY
  if (name === 'mnotify') return !!MNOTIFY_API_KEY
  return false
}

// OTP auto-failover breaker. The delivery-sync cron OPENS it (admin_settings key
// 'sms_otp_breaker') when recent Moolre OTP delivery is failing; while open, OTP
// sends LEAD with the fallback provider instead of Moolre. It auto-closes when
// Moolre recovers. Cached 60s so we don't hit the DB on every send.
let otpBreakerCache: { open: boolean; expiresAt: number } | null = null
async function isOtpBreakerOpen(): Promise<boolean> {
  if (otpBreakerCache && otpBreakerCache.expiresAt > Date.now()) return otpBreakerCache.open
  try {
    const { data } = await supabase.from('admin_settings').select('value').eq('key', 'sms_otp_breaker').maybeSingle()
    const v: any = data?.value
    const open = v?.open === true && !!v?.until && new Date(v.until).getTime() > Date.now()
    otpBreakerCache = { open, expiresAt: Date.now() + 60_000 }
    return open
  } catch {
    return false // fail safe — don't reroute on a DB hiccup
  }
}

/**
 * Send SMS using the configured provider (Brevo, Moolre, or mNotify).
 *
 * Every message fails over on a hard REJECT: it tries the primary provider, then
 * the fallback(s), until one accepts. OTP additionally prefers SMS_OTP_PROVIDER
 * first. The chain only advances when a provider returns failure, so a normally
 * accepted send is a single call — there is NO double-send here (delivered-but-
 * not-DLR'd is the cron's concern, not this path).
 */
export async function sendSMS(payload: SMSPayload): Promise<SendSMSResponse> {
  console.log('[SMS] sendSMS called with:', { phone: payload.phone, type: payload.type, provider: SMS_PROVIDER })

  if (process.env.SMS_ENABLED !== 'true') {
    console.log('[SMS] SMS disabled (SMS_ENABLED !== true), skipping')
    return { success: true, skipped: true }
  }

  const isOtp = payload.type === 'phone_otp'

  // Fetch DB-configurable routing (5-min TTL cache); falls back to env vars on error.
  const routing = await getRoutingConfig()
  const primaryProvider = routing.primary
  const fallbackProvider = routing.fallbacks[0] ?? process.env.SMS_FALLBACK_PROVIDER ?? 'mnotify'

  // Build the provider order. OTP prefers SMS_OTP_PROVIDER; everything else leads
  // with the configured primary. Both then fall back through the other gateways
  // (only on a hard reject), so a primary rejection auto-retries via fallbacks.
  let order: string[]
  if (isOtp) {
    // While the breaker is OPEN (Moolre OTP failing), lead with the fallback
    // provider; otherwise lead with SMS_OTP_PROVIDER (or the primary).
    const breakerOpen = await isOtpBreakerOpen()
    const lead = breakerOpen ? fallbackProvider : (process.env.SMS_OTP_PROVIDER || primaryProvider)
    if (breakerOpen) console.warn(`[SMS] OTP breaker open — leading with '${lead}' instead of primary`)
    order = [lead, fallbackProvider, primaryProvider, ...routing.fallbacks]
  } else {
    order = [primaryProvider, ...routing.fallbacks]
  }
  // De-dupe, keep only known + configured providers.
  order = [...new Set(order)].filter((p) => SMS_SENDERS[p] && isProviderConfigured(p))
  if (order.length === 0) order = [primaryProvider] // last resort — let it surface its own error

  let last: SendSMSResponse = { success: false, error: 'No SMS provider available' }
  for (const name of order) {
    const result = await (SMS_SENDERS[name] || sendSMSViaMoolre)(payload)
    if (result.success) {
      if (name !== order[0]) console.warn(`[SMS] ✓ '${payload.type}' delivered via fallback provider '${name}'`)
      return result
    }
    last = result
    console.warn(`[SMS] '${payload.type}' send via '${name}' failed (${result.error}); trying next provider`)
  }
  return last
}

/**
 * Resend a message via the FALLBACK provider (mNotify by default, override with
 * SMS_FALLBACK_PROVIDER). Used by the delivery-sync cron when Moolre accepted a
 * message but the telco didn't deliver it. Returns the provider's result; the
 * provider function logs its own sms_logs row (so the resend shows in the panel).
 */
export async function sendSMSViaFallback(payload: SMSPayload): Promise<SendSMSResponse> {
  if (process.env.SMS_ENABLED !== 'true') return { success: true, skipped: true }
  const fb = process.env.SMS_FALLBACK_PROVIDER || 'mnotify'
  const sender = SMS_SENDERS[fb]
  if (!sender || !isProviderConfigured(fb)) {
    return { success: false, error: `Fallback provider '${fb}' not configured` }
  }
  return sender(payload)
}

/**
 * Send SMS with retry logic
 */
export async function sendSMSWithRetry(
  payload: SMSPayload,
  maxRetries: number = 3
): Promise<SendSMSResponse> {
  for (let i = 0; i < maxRetries; i++) {
    const result = await sendSMS(payload)
    if (result.success) return result

    console.warn(`[SMS] Retry ${i + 1}/${maxRetries}`)
    // Wait before retrying (exponential backoff)
    await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)))
  }

  console.error('[SMS] Max retries exceeded for:', payload.phone)
  return {
    success: false,
    error: 'Max retries exceeded',
  }
}

/**
 * Get admin phone numbers automatically from public.users table
 * Queries users with role='admin' and a valid phone_number
 * Falls back to admin_settings table or environment variable
 */
async function getAdminPhoneNumbers(): Promise<string[]> {
  const phones: string[] = []

  // Primary: Query the public.users table for admins with phone numbers
  try {
    const { data: adminUsers, error: usersError } = await supabase
      .from('users')
      .select('id, phone_number, role')
      .eq('role', 'admin')
      .not('phone_number', 'is', null)

    if (!usersError && adminUsers && adminUsers.length > 0) {
      for (const user of adminUsers) {
        if (user.phone_number) {
          phones.push(user.phone_number)
          console.log(`[SMS] Found admin phone from users table: ${user.phone_number.substring(0, 6)}***`)
        }
      }
    }

    if (phones.length > 0) {
      console.log(`[SMS] Found ${phones.length} admin phone number(s) from public.users table`)
      return phones
    }
  } catch (e) {
    console.warn('[SMS] Could not fetch admin phones from users table:', e)
  }

  // Fallback: try from admin_settings table
  try {
    const { data, error } = await supabase
      .from('admin_settings')
      .select('value')
      .eq('key', 'admin_notification_phones')
      .single()

    if (!error && data?.value?.phones && Array.isArray(data.value.phones)) {
      const settingsPhones = data.value.phones as string[]
      if (settingsPhones.length > 0) {
        console.log(`[SMS] Found ${settingsPhones.length} admin phone(s) from admin_settings`)
        return settingsPhones
      }
    }
  } catch (e) {
    console.warn('[SMS] Could not fetch admin phones from admin_settings:', e)
  }

  // Final fallback: environment variable (comma-separated)
  const envPhones = process.env.ADMIN_NOTIFICATION_PHONES
  if (envPhones) {
    const envPhonesList = envPhones.split(',').map((p: string) => p.trim()).filter(Boolean)
    if (envPhonesList.length > 0) {
      console.log(`[SMS] Using ${envPhonesList.length} admin phone(s) from environment variable`)
      return envPhonesList
    }
  }

  return []
}

/**
 * Send SMS notification to all admin users
 * Used for critical alerts like fulfillment failures
 */
export async function notifyAdmins(message: string, type: string, reference?: string, skipEmailFallback = false): Promise<void> {
  // Check if SMS is known to be exhausted
  const now = Date.now()
  if (isSmsExhausted && (now - lastExhaustionCheck < EXHAUSTION_CACHE_MS)) {
    console.warn('[SMS] SMS is exhausted. Skipping admin notification.')
    if (!skipEmailFallback) {
      console.log('[SMS] Triggering Email fallback for exhausted SMS.')
      await sendAdminEmail(`[SMS FALLBACK] ${type}`, message)
    }
    return
  }

  const adminPhones = await getAdminPhoneNumbers()

  if (adminPhones.length === 0) {
    console.warn('[SMS] No admin phone numbers configured. Using Email fallback.')
    await sendAdminEmail(`[ALERT] ${type}`, message)
    return
  }

  console.log(`[SMS] Notifying ${adminPhones.length} admin(s): ${type}`)

  // Track if we need to fallback because of a 402 during this attempt
  let fallbackNeeded = false

  // Send to all admins in parallel
  const sendPromises = adminPhones.map(phone =>
    sendSMS({
      phone,
      message,
      type,
      reference,
    }).then(result => {
      if (!result.success && result.provider === 'brevo' && result.error?.includes('credit')) {
        fallbackNeeded = true
      }
    }).catch(err => {
      console.error(`[SMS] Failed to notify admin ${phone}:`, err)
    })
  )

  await Promise.allSettled(sendPromises)

  // If we hit a 402 during the send, trigger email fallback immediately for this alert (if allowed)
  if (fallbackNeeded && !skipEmailFallback) {
    console.warn('[SMS] 402 Detected during notifyAdmins. Triggering Email fallback.')
    await sendAdminEmail(`[SMS FALLBACK] ${type}`, message)
  }
}

/**
 * Notify admins of a fulfillment failure
 */
export async function notifyFulfillmentFailure(
  orderId: string,
  customerPhone: string,
  network: string,
  volumeGb: number | string,
  reason: string,
  skipEmailFallback = false
): Promise<void> {
  const message = SMSTemplates.fulfillmentFailed(orderId, customerPhone, network, volumeGb.toString(), reason)
  await notifyAdmins(message, 'fulfillment_failure', orderId, skipEmailFallback)

  import('./push-service').then(({ notifyAdminsPush }) => {
    notifyAdminsPush({
      title: '⚠️ Fulfillment Failed',
      body: `${network} ${volumeGb}GB to ${customerPhone} — ${reason} (Order: ${orderId.substring(0, 8)})`,
      data: { url: '/admin/orders' },
    }).catch(() => {})
  }).catch(() => {})
}

/**
 * Notify admins of price manipulation detection
 */
export async function notifyPriceManipulation(
  customerPhone: string,
  actualPrice: number,
  manipulatedPrice: number,
  skipEmailFallback = false
): Promise<void> {
  const message = `[FRAUD ALERT] Price manipulation detected! Phone: ${customerPhone} | Paid: GHS${actualPrice} | Expected: GHS${manipulatedPrice}`
  await notifyAdmins(message, 'price_manipulation', customerPhone, skipEmailFallback)
}

/**
 * Notify admins of payment mismatch
 */
export async function notifyPaymentMismatch(
  reference: string,
  paidAmount: number,
  expectedAmount: number,
  skipEmailFallback = false
): Promise<void> {
  const message = SMSTemplates.paymentMismatchDetected(reference, paidAmount.toFixed(2), expectedAmount.toFixed(2))
  await notifyAdmins(message, 'payment_mismatch', reference, skipEmailFallback)
}
