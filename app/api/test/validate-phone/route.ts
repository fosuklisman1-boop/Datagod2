import { NextRequest, NextResponse } from 'next/server'
import { normalizePhoneNumber, getNetworkFromPhone, isValidPhoneFormat } from '@/lib/mtn-fulfillment'

export async function POST(request: NextRequest) {
  try {
    const { phone } = await request.json()

    if (!phone) {
      return NextResponse.json(
        { error: 'Phone number required' },
        { status: 400 }
      )
    }

    const normalized = normalizePhoneNumber(phone)
    const valid = isValidPhoneFormat(normalized)

    if (!valid) {
      return NextResponse.json(
        { valid: false, error: 'Invalid phone number format', raw: phone },
        { status: 200 }
      )
    }

    const network = getNetworkFromPhone(normalized)

    return NextResponse.json({
      valid: true,
      raw: phone,
      normalized,
      network,
      format: `+233${normalized}`
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Validation failed' },
      { status: 500 }
    )
  }
}
