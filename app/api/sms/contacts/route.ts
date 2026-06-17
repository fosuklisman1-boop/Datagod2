import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { addContact, bulkImportContacts } from "@/lib/sms/tenant-address-book-service"

// POST /api/sms/contacts
//   Single: { group_id, phone_number, first_name?, last_name? }
//   Bulk:   { group_id, rows: [{ phone_number, first_name?, last_name? }], verify? }
export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error

  let body: {
    group_id?: string
    phone_number?: string
    first_name?: string | null
    last_name?: string | null
    rows?: { phone_number: string; first_name?: string | null; last_name?: string | null }[]
    verify?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.group_id) {
    return NextResponse.json({ success: false, error: "group_id is required" }, { status: 400 })
  }

  if (Array.isArray(body.rows)) {
    const result = await bulkImportContacts(account.id, body.group_id, body.rows, { verify: body.verify === true })
    if (!result.ok) {
      const status = result.error === "Group not found" ? 404 : 400
      return NextResponse.json({ success: false, error: result.error }, { status })
    }
    return NextResponse.json({ success: true, data: result.data })
  }

  if (!body.phone_number) {
    return NextResponse.json({ success: false, error: "phone_number is required" }, { status: 400 })
  }
  const result = await addContact(account.id, body.group_id, {
    phone_number: body.phone_number,
    first_name: body.first_name ?? null,
    last_name: body.last_name ?? null,
  })
  if (!result.ok) {
    const status = result.error === "Group not found" ? 404 : 400
    return NextResponse.json({ success: false, error: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
