import axios from 'axios'
import { createClient } from '@supabase/supabase-js'
import { notifyAdmins as sendAdminEmail } from './email-service'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// SMS Provider Configuration
const SMS_PROVIDER = process.env.SMS_PROVIDER || 'moolre' // 'moolre' or 'brevo'
const BREVO_API_KEY = process.env.BREVO_API_KEY
const BREVO_SMS_SENDER = process.env.BREVO_SMS_SENDER || process.env.EMAIL_SENDER_NAME || 'DATAGOD'
const MOOLRE_API_KEY = process.env.MOOLRE_API_KEY
const MOOLRE_SENDER_ID = process.env.MOOLRE_SENDER_ID || 'CLINGDTGOD'

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
}

interface SendSMSResponse {
  success: boolean
  messageId?: string
  skipped?: boolean
  error?: string
  provider?: string
}

// SMS Templates
export const SMSTemplates = {
  walletTopUpInitiated: (amount: string, ref: string) =>
    `DATAGOD: Wallet top-up of GHS ${amount} initiated. Ref: ${ref}. Processing...`,

  walletTopUpSuccess: (amount: string, balance: string) =>
    `DATAGOD: ✓ Wallet topped up by GHS ${amount}. New balance: GHS ${balance}`,

  walletTopUpFailed: (amount: string) =>
    `DATAGOD: ✗ Wallet top-up failed. GHS ${amount}. Try again or contact support.`,

  orderCreated: (orderId: string, network: string, volume: string, amount: string) =>
    `DATAGOD: Order confirmed! ID: ${orderId} | ${network} ${volume}GB | GHS ${amount} | Status: Pending payment`,

  orderPaymentConfirmed: (orderId: string, network: string, volume: string, amount: string) =>
    `DATAGOD: ✓ Payment confirmed for order ${orderId}! ${network} ${volume}GB - GHS ${amount}. Processing...`,

  orderDelivered: (orderId: string) =>
    `DATAGOD: Order #${orderId} delivered. Thank you for shopping with us!`,

  withdrawalApproved: (amount: string, ref: string) =>
    `DATAGOD: Withdrawal approved! GHS ${amount} will be transferred. Ref: ${ref}`,

  withdrawalRejected: (amount: string) =>
    `DATAGOD: Withdrawal request GHS ${amount} rejected. Contact support.`,

  verificationCode: (code: string) =>
    `DATAGOD: Your verification code is ${code}. Valid for 10 minutes.`,

  passwordReset: (link: string) =>
    `DATAGOD: Click to reset password: ${link}. Valid for 1 hour. Don't share!`,

  // Admin notifications
  fulfillmentFailed: (orderId: string, phone: string, network: string, sizeGb: string, reason: string) =>
    `[ADMIN] Fulfillment FAILED! Order: ${orderId.substring(0, 8)} | ${phone} | ${network} ${sizeGb}GB | Reason: ${reason.substring(0, 50)}`,

  // Price manipulation alert
  priceManipulationDetected: (phone: string, clientPrice: string, actualPrice: string, network: string, volume: string) =>
    `[FRAUD ALERT] Price manipulation detected! Phone: ${phone} | Sent: GHS${clientPrice} | Actual: GHS${actualPrice} | ${network} ${volume}GB`,

  // Payment mismatch alert  
  paymentMismatchDetected: (reference: string, paidAmount: string, expectedAmount: string) =>
    `[FRAUD ALERT] Payment mismatch! Ref: ${reference} | Paid: GHS${paidAmount} | Expected: GHS${expectedAmount}`,

  // Admin credit/debit notifications to user
  adminCredited: (amount: string, balance: string) =>
    `DATAGOD: ✓ Your wallet has been credited GHS ${amount} by admin. New balance: GHS ${balance}`,

  adminDebited: (amount: string, balance: string) =>
    `DATAGOD: Your wallet has been debited GHS ${amount} by admin. New balance: GHS ${balance}`,

  // Dealer subscription notifications
  subscriptionSuccess: (planName: string, endDate: string) =>
    `DATAGOD: ✓ Subscription activated! Plan: ${planName}. Valid until ${endDate}. Enjoy dealer privileges!`,

  subscriptionExpiry1Day: (planName: string, endDate: string) =>
    `DATAGOD: Your ${planName} subscription expires in 1 day (${endDate}). Renew now to keep dealer access.`,

  subscriptionExpiry12Hours: (planName: string, endDate: string) =>
    `DATAGOD: ⚠️ Your ${planName} subscription expires in 12 hours (${endDate}). Renew to avoid interruption.`,

  subscriptionExpiry6Hours: (planName: string, endDate: string) =>
    `DATAGOD: ⚠️ URGENT: Your ${planName} subscription expires in 6 hours (${endDate}). Renew now!`,

  subscriptionExpiry1Hour: (planName: string, endDate: string) =>
    `DATAGOD: 🚨 CRITICAL: Your ${planName} subscription expires in 1 hour (${endDate}). Renew immediately!`,
}

/**
 * Normalize phone number to Moolre format
 * Accepts: +233XXXXXXXXX, 0XXXXXXXXX, 233XXXXXXXXX
 * Returns: +233XXXXXXXXX
 */
function normalizePhoneNumber(phone: string): string {
  // Remove spaces, dashes, parentheses
  phone = phone.replace(/[\s\-\(\)]/g, '')

  // If starts with 0 (local Ghana format), replace with +233
  if (phone.startsWith('0')) {
    phone = '+233' + phone.substring(1)
  }

  // If doesn't have country code, add it
  if (!phone.startsWith('+')) {
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

    // Log to database
    if (payload.userId) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId,
          phone_number: payload.phone,
          message: payload.message,
          message_type: payload.type,
          reference_id: payload.reference,
          moolre_message_id: messageId, // Reuse column for Brevo message ID
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

    // Log failed SMS
    if (payload.userId) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId,
          phone_number: payload.phone,
          message: payload.message,
          message_type: payload.type,
          reference_id: payload.reference,
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

    const queryParams = new URLSearchParams({
      type: '1',
      senderid: MOOLRE_SENDER_ID,
      recipient: normalizedPhone,
      message: payload.message,
    })

    if (payload.reference) {
      queryParams.append('ref', payload.reference)
    }

    const url = `https://api.moolre.com/open/sms/send?${queryParams.toString()}&X-API-VASKEY=${MOOLRE_API_KEY}`

    console.log('[SMS] Moolre request to:', payload.phone.substring(0, 6) + '***')

    const response = await axios.get(url)

    if (response.data.status !== 1) {
      throw new Error(`Moolre API Error: ${response.data.message || 'Unknown error'}`)
    }

    const messageId = response.data.data?.messages?.[0]?.id || response.data.data?.id || response.data.id || 'unknown'
    console.log('[SMS] ✓ Moolre Success - Message ID:', messageId)

    // Log to database
    if (payload.userId) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId,
          phone_number: payload.phone,
          message: payload.message,
          message_type: payload.type,
          reference_id: payload.reference,
          moolre_message_id: messageId,
          status: 'sent',
        })
      } catch (logError) {
        console.warn('[SMS] Failed to log SMS:', logError)
      }
    }

    return {
      success: true,
      messageId,
      provider: 'moolre',
    }
  } catch (error) {
    console.error('[SMS] Moolre Error:', error)

    let errorMessage = 'Failed to send SMS via Moolre'
    if (axios.isAxiosError(error)) {
      errorMessage = error.response?.data?.message || error.message
    }

    // Log failed SMS
    if (payload.userId) {
      try {
        await supabase.from('sms_logs').insert({
          user_id: payload.userId,
          phone_number: payload.phone,
          message: payload.message,
          message_type: payload.type,
          reference_id: payload.reference,
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
 * Send SMS using configured provider (Brevo or Moolre)
 */
export async function sendSMS(payload: SMSPayload): Promise<SendSMSResponse> {
  console.log('[SMS] sendSMS called with:', { phone: payload.phone, type: payload.type, provider: SMS_PROVIDER })

  if (process.env.SMS_ENABLED !== 'true') {
    console.log('[SMS] SMS disabled (SMS_ENABLED !== true), skipping')
    return { success: true, skipped: true }
  }

  // Route to the appropriate provider
  if (SMS_PROVIDER === 'brevo') {
    return sendSMSViaBrevo(payload)
  } else {
    return sendSMSViaMoolre(payload)
  }
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
export async function notifyAdmins(message: string, type: string, reference?: string): Promise<void> {
  // Check if SMS is known to be exhausted
  const now = Date.now()
  if (isSmsExhausted && (now - lastExhaustionCheck < EXHAUSTION_CACHE_MS)) {
    console.warn('[SMS] SMS is exhausted. Falling back to Email for admin notification.')
    await sendAdminEmail(`[SMS FALLBACK] ${type}`, message)
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

  // If we hit a 402 during the send, trigger email fallback immediately for this alert
  if (fallbackNeeded) {
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
  sizeGb: number,
  reason: string
): Promise<void> {
  const message = SMSTemplates.fulfillmentFailed(
    orderId,
    customerPhone,
    network,
    sizeGb.toString(),
    reason
  )

  await notifyAdmins(message, 'fulfillment_failure', orderId)
}

/**
 * Notify admins of a price manipulation attempt during order creation
 */
export async function notifyPriceManipulation(
  customerPhone: string,
  clientPrice: number,
  actualPrice: number,
  network: string,
  volumeGb: number
): Promise<void> {
  const message = SMSTemplates.priceManipulationDetected(
    customerPhone,
    clientPrice.toFixed(2),
    actualPrice.toFixed(2),
    network,
    volumeGb.toString()
  )

  await notifyAdmins(message, 'price_manipulation', customerPhone)
}

/**
 * Notify admins of a payment amount mismatch (potential fraud)
 */
export async function notifyPaymentMismatch(
  reference: string,
  paidAmount: number,
  expectedAmount: number
): Promise<void> {
  const message = SMSTemplates.paymentMismatchDetected(
    reference,
    paidAmount.toFixed(2),
    expectedAmount.toFixed(2)
  )

  await notifyAdmins(message, 'payment_mismatch', reference)
}
