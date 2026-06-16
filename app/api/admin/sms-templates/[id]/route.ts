import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { updateTemplate, deleteTemplate } from "@/lib/sms/address-book-service"

// PATCH /api/admin/sms-templates/[id] — update name/body
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const { id } = await params
  let body: { name?: string; body?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const result = await updateTemplate(id, body)
  if (!result.ok) {
    const status = result.error === "Template not found" ? 404 : 400
    return NextResponse.json({ success: false, error: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.data })
}

// DELETE /api/admin/sms-templates/[id]
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const { id } = await params
  const result = await deleteTemplate(id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}
