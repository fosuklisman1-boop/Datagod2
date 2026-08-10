import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { hasWhitelistProviders, listWhitelistProviders } from "@/lib/mtn-providers/provider-whitelist"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  return NextResponse.json({ available: hasWhitelistProviders(), providers: listWhitelistProviders() })
}
