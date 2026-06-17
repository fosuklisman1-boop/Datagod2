import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getGroupWithContacts, updateGroup, deleteGroup } from "@/lib/sms/tenant-address-book-service"

// GET /api/sms/groups/[id] — group + its contacts (scoped to the account)
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const { id } = await params
  const result = await getGroupWithContacts(account.id, id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}

// PATCH /api/sms/groups/[id] — { name?, description? }
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const { id } = await params
  let body: { name?: string; description?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  const result = await updateGroup(account.id, id, body)
  if (!result.ok) {
    const status = result.error === "Group not found" ? 404 : 400
    return NextResponse.json({ success: false, error: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.data })
}

// DELETE /api/sms/groups/[id] — delete group (cascades to contacts)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const { id } = await params
  const result = await deleteGroup(account.id, id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}
