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
 * Send SMS via Moolre API
 */
export async function sendSMS(payload: SMSPayload): Promise<SendSMSResponse> {
  if (process.env.SMS_ENABLED !== 'true') {
    console.log('[SMS] SMS disabled, skipping:', payload.message.substring(0, 50))
    return { success: true, skipped: true }
  }

  if (!process.env.MOOLRE_API_KEY) {
    console.warn('[SMS] Moolre API key not configured')
    return { success: false, error: 'SMS service not configured' }
  }

  try {
    const normalizedPhone = normalizePhoneNumber(payload.phone)

    console.log('[SMS] Sending to:', normalizedPhone, '- Message:', payload.message.substring(0, 60))

    const moolreClient = axios.create({
      baseURL: process.env.MOOLRE_API_URL || 'https://api.moolre.com/v1',
      headers: {
        'X-API-USER': process.env.MOOLRE_API_USER || '',
        'X-API-KEY': process.env.MOOLRE_API_KEY || '',
        'X-API-PUBKEY': process.env.MOOLRE_API_PUBKEY || '',
        'X-API-VASKEY': process.env.MOOLRE_API_VASKEY || '',
        'Content-Type': 'application/json',
      },
    })

    const response = await moolreClient.post('/sms/send', {
      phone: normalizedPhone,
      message: payload.message,
      senderId: process.env.MOOLRE_SENDER_ID || 'DGOD',
      scheduleTime: null,
    })

    const messageId = response.data.messageId || response.data.id
    console.log('[SMS] ✓ Success - Message ID:', messageId)

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
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
      } catch (logError) {
        console.warn('[SMS] Failed to log failed SMS:', logError)
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send SMS',
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
