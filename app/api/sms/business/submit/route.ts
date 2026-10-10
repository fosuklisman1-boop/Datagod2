import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { submitKyc, toPublicKyc } from "@/lib/sms/kyc-service"

export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const r = await submitKyc(account.id)
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, data: toPublicKyc(r.data) })
}
