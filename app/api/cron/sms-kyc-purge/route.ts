import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { purgeKycDocuments } from "@/lib/sms/kyc-service"

/** Delete KYC documents 30 days after the admin's decision. Daily. */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!
  return NextResponse.json({ success: true, data: await purgeKycDocuments() })
}
