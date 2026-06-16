import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getGroupWithContacts, updateGroup, deleteGroup } from "@/lib/sms/address-book-service"

// GET /api/admin/sms-groups/[id] — group detail + its contacts
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const { id } = await params
  const result = await getGroupWithContacts(id)
  if (!result.ok) {
    const status = result.error === "Group not found" ? 404 : 500
    return NextResponse.json({ success: false, error: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.data })
}

// PATCH /api/admin/sms-groups/[id] — update name/description
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const { id } = await params
  let body: { name?: string; description?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const result = await updateGroup(id, body)
  if (!result.ok) {
    const status = result.error === "Group not found" ? 404 : 400
    return NextResponse.json({ success: false, error: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.data })
}

// DELETE /api/admin/sms-groups/[id] — delete group (cascades to contacts)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const { id } = await params
  const result = await deleteGroup(id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}
