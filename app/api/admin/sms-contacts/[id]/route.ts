import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { deleteContact, setContactOptedOut } from "@/lib/sms/address-book-service"

// PATCH /api/admin/sms-contacts/[id] — toggle opt-out  { opted_out: boolean }
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const { id } = await params
  let body: { opted_out?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (typeof body.opted_out !== "boolean")
    return NextResponse.json({ success: false, error: "opted_out (boolean) is required" }, { status: 400 })

  const result = await setContactOptedOut(id, body.opted_out)
  if (!result.ok) {
    const status = result.error === "Contact not found" ? 404 : 400
    return NextResponse.json({ success: false, error: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.data })
}

// DELETE /api/admin/sms-contacts/[id]
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const { id } = await params
  const result = await deleteContact(id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}
