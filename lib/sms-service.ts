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
  console.log('[SMS] sendSMS called with:', { phone: payload.phone, type: payload.type })
  
  if (process.env.SMS_ENABLED !== 'true') {
    console.log('[SMS] SMS disabled (SMS_ENABLED !== true), skipping:', payload.message.substring(0, 50))
    return { success: true, skipped: true }
  }

  if (!process.env.MOOLRE_API_VASKEY) {
    console.warn('[SMS] Moolre API VASKEY not configured')
    return { success: false, error: 'SMS service not configured' }
  }

  console.log('[SMS] SMS_ENABLED is true, proceeding with send')
  console.log('[SMS] Environment variables check:', {
    hasVasKey: !!process.env.MOOLRE_API_VASKEY,
    hasSenderId: !!process.env.MOOLRE_SENDER_ID,
  })

  try {
    const normalizedPhone = normalizePhoneNumber(payload.phone)

    console.log('[SMS] Sending to:', normalizedPhone, '- Message:', payload.message.substring(0, 60))

    const vasKey = process.env.MOOLRE_API_VASKEY || ''
    const senderId = process.env.MOOLRE_SENDER_ID || 'DGOD'
    
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

    console.log('[SMS] Making GET request to:', url.substring(0, 100) + '...')
    console.log('[SMS] Request params:', {
      type: '1',
      senderid: senderId,
      recipient: normalizedPhone,
      message: payload.message.substring(0, 60) + '...',
      ref: payload.reference || '',
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
