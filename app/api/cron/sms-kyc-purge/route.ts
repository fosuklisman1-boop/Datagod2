import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { purgeKycDocuments } from "@/lib/sms/kyc-service"

/** Delete KYC documents 30 days after the admin's decision. Daily. */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!
  const result = await purgeKycDocuments()
  if (result.errors > 0) return NextResponse.json({ success: false, error: "Some KYC documents could not be purged", data: result }, { status: 500 })
  return NextResponse.json({ success: true, data: result })
}
