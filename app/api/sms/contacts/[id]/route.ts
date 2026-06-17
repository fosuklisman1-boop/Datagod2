import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { setContactOptedOut, deleteContact } from "@/lib/sms/tenant-address-book-service"

// PATCH /api/sms/contacts/[id] — { opted_out: boolean }
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const { id } = await params
  let body: { opted_out?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (typeof body.opted_out !== "boolean") {
    return NextResponse.json({ success: false, error: "opted_out (boolean) is required" }, { status: 400 })
  }
  const result = await setContactOptedOut(account.id, id, body.opted_out)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}

// DELETE /api/sms/contacts/[id]
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const { id } = await params
  const result = await deleteContact(account.id, id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}
