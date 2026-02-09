import axios from 'axios'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

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
export function normalizePhoneNumber(phone: string): string {
  // Remove spaces, dashes, parentheses, and plus sign
  phone = phone.replace(/[\s\-\(\)\+]/g, '')

  // If starts with 233 (country code), it's already normalized (without +)
  if (phone.startsWith('233') && phone.length >= 12) {
    return '+' + phone
  }

  // If starts with 0 (local Ghana format), replace with 233
  if (phone.startsWith('0')) {
    phone = '233' + phone.substring(1)
  }

  // If still doesn't start with 233 and is 9 digits, add 233
  if (!phone.startsWith('233') && phone.length === 9) {
    phone = '233' + phone
  }

  return '+' + phone
}

/**
 * Send SMS via Moolre API
 */
export async function sendSMS(payload: SMSPayload): Promise<SendSMSResponse> {
  console.log('[SMS] sendSMS called with:', { phone: payload.phone, type: payload.type })

  if (process.env.SMS_ENABLED !== 'true') {
    console.log('[SMS] SMS disabled (SMS_ENABLED !== true), skipping:', payload.message.substring(0, 50))
    return { success: true, skipped: true }
  }

  if (!process.env.MOOLRE_API_KEY) {
    console.warn('[SMS] Moolre API key not configured')
    return { success: false, error: 'SMS service not configured' }
  }

  console.log('[SMS] SMS_ENABLED is true, proceeding with send')
  console.log('[SMS] Environment variables check:', {
    hasApiKey: !!process.env.MOOLRE_API_KEY,
    hasSenderId: !!process.env.MOOLRE_SENDER_ID,
  })

  try {
    const normalizedPhone = normalizePhoneNumber(payload.phone)

    console.log('[SMS] Sending to:', normalizedPhone, '- Message:', payload.message.substring(0, 60))

    const vasKey = process.env.MOOLRE_API_KEY || ''
    const senderId = process.env.MOOLRE_SENDER_ID || 'CLINGDTGOD'

    // Build query parameters
    const queryParams = new URLSearchParams({
      type: '1',
      senderid: senderId,
      recipient: normalizedPhone,
      message: payload.message,
    })

    if (payload.reference) {
      queryParams.append('ref', payload.reference)
    }

    const url = `https://api.moolre.com/open/sms/send?${queryParams.toString()}&X-API-VASKEY=${vasKey}`

    console.log('[SMS] Making GET request to:', `https://api.moolre.com/open/sms/send?${queryParams.toString()}&X-API-VASKEY=***`)
    console.log('[SMS] Request fields:', {
      type: '1',
      senderid: senderId,
      recipient: normalizedPhone,
      message: payload.message.substring(0, 60) + '...',
      ref: payload.reference || '',
      hasVasKey: !!vasKey,
    })

    const response = await axios.get(url)

    console.log('[SMS] Response received:', response.data)

    // Check if response indicates success
    if (response.data.status !== 1) {
      throw new Error(`Moolre API Error: ${response.data.message || 'Unknown error'}`)
    }

    // Extract message ID from response data
    const messageId = response.data.data?.messages?.[0]?.id || response.data.data?.id || response.data.id || 'unknown'
    console.log('[SMS] ✓ Success - Message ID:', messageId)
    console.log('[SMS] Response:', response.data.message || 'Success')

    // Log to database if user provided
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
    }
  } catch (error) {
    console.error('[SMS] Error sending SMS:', error)

    // Extract error details
    let errorMessage = 'Failed to send SMS'
    if (axios.isAxiosError(error)) {
      errorMessage = error.response?.data?.message || error.message
      console.error('[SMS] Moolre Error:', {
        status: error.response?.status,
        code: error.response?.data?.code,
        message: error.response?.data?.message,
      })
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
    }
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
  const adminPhones = await getAdminPhoneNumbers()

  if (adminPhones.length === 0) {
    console.warn('[SMS] No admin phone numbers configured for notifications')
    return
  }

  console.log(`[SMS] Notifying ${adminPhones.length} admin(s): ${type}`)

  // Send to all admins in parallel (non-blocking)
  const sendPromises = adminPhones.map(phone =>
    sendSMS({
      phone,
      message,
      type,
      reference,
    }).catch(err => {
      console.error(`[SMS] Failed to notify admin ${phone}:`, err)
    })
  )

  await Promise.allSettled(sendPromises)
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
