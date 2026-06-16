import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listTemplates, createTemplate } from "@/lib/sms/address-book-service"

// GET /api/admin/sms-templates — list all templates
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const result = await listTemplates()
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}

// POST /api/admin/sms-templates — create a template  { name, body }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { name?: string; body?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.name || !body.body)
    return NextResponse.json({ success: false, error: "name and body are required" }, { status: 400 })

  const result = await createTemplate(body.name, body.body)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
