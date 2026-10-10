import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getCurrentKyc, saveKycDraft, toPublicKyc } from "@/lib/sms/kyc-service"

export async function GET(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const profile = await getCurrentKyc(account.id)
  return NextResponse.json({ success: true, data: { mode: (account as { mode?: string }).mode ?? "platform", profile: profile ? toPublicKyc(profile) : null } })
}

// PUT { business_name?, description?, website?, whatsapp_number?, ghana_card_number? }
export async function PUT(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  if (!body || typeof body !== "object") return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  const pick = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined)
  const r = await saveKycDraft(account.id, {
    business_name: pick("business_name"), description: pick("description"), website: pick("website"),
    whatsapp_number: pick("whatsapp_number"), ghana_card_number: pick("ghana_card_number"),
  })
  if (!r.ok) return NextResponse.json({ success: false, error: r.error, fields: r.fields }, { status: 400 })
  return NextResponse.json({ success: true, data: toPublicKyc(r.data) })
}
