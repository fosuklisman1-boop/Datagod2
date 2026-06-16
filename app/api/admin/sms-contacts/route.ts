import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { addContact, bulkImportContacts } from "@/lib/sms/address-book-service"

// POST /api/admin/sms-contacts
//   Single:  { group_id, phone_number, first_name?, last_name? }
//   Bulk:    { group_id, rows: [{ phone_number, first_name?, last_name? }, ...] }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: {
    group_id?: string
    phone_number?: string
    first_name?: string | null
    last_name?: string | null
    rows?: { phone_number: string; first_name?: string | null; last_name?: string | null }[]
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.group_id) return NextResponse.json({ success: false, error: "group_id is required" }, { status: 400 })

  // Bulk path
  if (Array.isArray(body.rows)) {
    const result = await bulkImportContacts(body.group_id, body.rows)
    if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
    return NextResponse.json({ success: true, data: result.data })
  }

  // Single path
  if (!body.phone_number)
    return NextResponse.json({ success: false, error: "phone_number or rows[] is required" }, { status: 400 })

  const result = await addContact(body.group_id, {
    first_name: body.first_name ?? null,
    last_name: body.last_name ?? null,
    phone_number: body.phone_number,
  })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
