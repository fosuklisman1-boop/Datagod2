import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listGroups, createGroup } from "@/lib/sms/address-book-service"

// GET /api/admin/sms-groups — list all groups with contact counts
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const result = await listGroups()
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}

// POST /api/admin/sms-groups — create a group  { name, description? }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { name?: string; description?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.name) return NextResponse.json({ success: false, error: "name is required" }, { status: 400 })

  const result = await createGroup(body.name, body.description ?? null)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
