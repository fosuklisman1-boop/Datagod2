import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Mirrors app/api/shop/invites/route.ts's generateInviteCode() exactly —
// approving a request creates a REAL shop_invites row via the same code
// shape/uniqueness check the owner-initiated flow already uses, so
// /join/[code] works identically regardless of which flow created it.
function generateInviteCode(): string {
  return crypto.randomBytes(4).toString("hex").toUpperCase()
}

// PATCH: approve or reject a pending sub-agent request. Owner-only (must own
// the shop the request was made against).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const action = body?.action
    if (action !== "approve" && action !== "reject") {
      return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 })
    }

    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, shop_name, is_active")
      .eq("user_id", user.id)
      .single()
    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    const { data: reqRow, error: reqError } = await supabase
      .from("sub_agent_requests")
      .select("*")
      .eq("id", id)
      .eq("shop_id", shop.id)
      .single()
    if (reqError || !reqRow) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 })
    }
    if (reqRow.status !== "pending") {
      return NextResponse.json({ error: "This request has already been reviewed" }, { status: 400 })
    }

    if (action === "reject") {
      await supabase
        .from("sub_agent_requests")
        .update({ status: "rejected", reviewed_at: new Date().toISOString() })
        .eq("id", id)
      return NextResponse.json({ success: true, status: "rejected" })
    }

    // ── Approve: create a real shop_invites row (same shape as the owner-
    // initiated POST /api/shop/invites), link it back, notify the requester. ──
    if (!shop.is_active) {
      return NextResponse.json({ error: "Your shop must be active to approve sub-agent requests" }, { status: 400 })
    }

    let inviteCode = generateInviteCode()
    for (let attempts = 0; attempts < 5; attempts++) {
      const { data: existing } = await supabase
        .from("shop_invites")
        .select("id")
        .eq("invite_code", inviteCode)
        .single()
      if (!existing) break
      inviteCode = generateInviteCode()
    }

    const { data: invite, error: createError } = await supabase
      .from("shop_invites")
      .insert({
        inviter_shop_id: shop.id,
        invite_code: inviteCode,
        email: reqRow.requester_phone,
        status: "pending",
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single()
    if (createError) {
      console.error("[SUB-AGENT-REQUEST] Invite creation failed:", createError.message)
      return NextResponse.json({ error: "Could not create the invite. Please try again." }, { status: 500 })
    }

    await supabase
      .from("sub_agent_requests")
      .update({ status: "approved", reviewed_at: new Date().toISOString(), invite_id: invite.id })
      .eq("id", id)

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://datagod.store"
    const inviteUrl = `${baseUrl}/join/${inviteCode}`

    try {
      const smsMessage = SMSTemplates.subAgentInvitation(inviteUrl)
      await sendSMS({ phone: reqRow.requester_phone, message: smsMessage, type: "sub_agent_invite", reference: invite.id })
    } catch (smsError) {
      console.warn("[SUB-AGENT-REQUEST] Failed to send SMS invite:", smsError)
    }

    if (reqRow.requester_email) {
      try {
        const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
        const expiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString()
        const template = EmailTemplates.subAgentInvitation(shop.shop_name, inviteUrl, expiryDate)
        await sendEmail({
          to: [{ email: reqRow.requester_email }],
          subject: template.subject,
          htmlContent: template.html,
          userId: user.id,
          type: "sub_agent_invite",
        })
      } catch (emailError) {
        console.warn("[SUB-AGENT-REQUEST] Failed to send Email invite:", emailError)
      }
    }

    return NextResponse.json({ success: true, status: "approved", invite_url: inviteUrl })
  } catch (error) {
    console.error("[SUB-AGENT-REQUEST] PATCH error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
