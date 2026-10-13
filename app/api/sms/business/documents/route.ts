import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { uploadKycDocument, toPublicKyc } from "@/lib/sms/kyc-service"

// POST multipart/form-data: kind=ghana_card|registration, file=<File>
export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  let form: FormData
  try { form = await request.formData() } catch { return NextResponse.json({ success: false, error: "Expected multipart form data" }, { status: 400 }) }
  const kind = form.get("kind")
  const file = form.get("file")
  if ((kind !== "ghana_card" && kind !== "registration") || !(file instanceof File)) {
    return NextResponse.json({ success: false, error: "kind (ghana_card|registration) and file are required" }, { status: 400 })
  }
  const r = await uploadKycDocument(account.id, kind, file)
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, data: toPublicKyc(r.data) })
}
