import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

/**
 * Paystack diagnostics endpoint.
 *
 * NOTE: This used to create a REAL Paystack transaction (live secret-key call to
 * /transaction/initialize) "to test the integration". That is a standing
 * liability — any code path that mints real Paystack transactions outside the
 * normal, gated payment flow is an abuse surface. It has been neutered: it now
 * only reports whether the required env vars are present and never contacts
 * Paystack. Admin-gated regardless.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  return NextResponse.json({
    success: true,
    disabled: true,
    message:
      "Live Paystack test transactions are disabled. This endpoint no longer " +
      "creates charges. Use the normal payment flow to validate integration.",
    envCheck: {
      PAYSTACK_SECRET_KEY: !!process.env.PAYSTACK_SECRET_KEY,
      NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: !!process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      PAYSTACK_CURRENCY: process.env.PAYSTACK_CURRENCY || "GHS (default)",
    },
  })
}
