import { NextRequest, NextResponse } from "next/server"
import { badRequest, gateAdmin, serviceClient, userIdParam, writeAudit, type IdCtx } from "@/lib/admin-users/route-utils"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/users/[id]/phone-verified   { verified: boolean }
 *
 * Sets public.users.phone_verified, the flag the phone gate reads (lib/phone-verify-guard.ts and the DB
 * backstop is_phone_gate_satisfied, migrations/0055). No existing admin endpoint wrote it: the
 * /admin/phone-verification page is the MTN number-whitelist checker, and /api/admin/phone-verifications/reset
 * clears storefront OTP rows. phone_verify_deadline is left alone, so marking a user unverified blocks gated
 * actions once any grace period they still have runs out.
 *
 * Audited as 'user_phone_verified' / 'user_phone_unverified' with the old and new value. Refuses the CRON bypass.
 * → { success, phoneVerified, changed, audited }
 */
export async function POST(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req, { write: true })
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response
  const adminId = gate.adminId!

  const body = await req.json().catch(() => null)
  if (!body || typeof body.verified !== "boolean") return badRequest("verified must be true or false")
  const verified: boolean = body.verified

  const db = serviceClient()
  const { data: user, error } = await db.from("users").select("id, phone_number, phone_verified").eq("id", idp.id).maybeSingle()
  if (error) return NextResponse.json({ error: "Failed to load user" }, { status: 500 })
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
  if (verified && !user.phone_number) return badRequest("This user has no phone number to verify")

  const before = user.phone_verified === true
  if (before === verified) return NextResponse.json({ success: true, phoneVerified: verified, changed: false, audited: false })

  const upd = await db.from("users")
    .update({ phone_verified: verified, updated_at: new Date().toISOString() })
    .eq("id", idp.id)
  if (upd.error) {
    console.error("[ADMIN-PHONE-VERIFIED]", upd.error.message)
    return NextResponse.json({ error: "Failed to update phone verification" }, { status: 500 })
  }

  const audited = await writeAudit(db, {
    admin_id: adminId,
    action: verified ? "user_phone_verified" : "user_phone_unverified",
    target_user_id: idp.id,
    old_value: { phone_verified: before, phone_number: user.phone_number },
    new_value: { phone_verified: verified, phone_number: user.phone_number },
  })
  return NextResponse.json({ success: true, phoneVerified: verified, changed: true, audited })
}
