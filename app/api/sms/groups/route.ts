import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { listGroups, createGroup } from "@/lib/sms/tenant-address-book-service"

// GET /api/sms/groups — the caller's own contact groups (with contact_count)
export async function GET(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const result = await listGroups(account.id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}

// POST /api/sms/groups — create a group  { name, description? }
export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  let body: { name?: string; description?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.name) return NextResponse.json({ success: false, error: "name is required" }, { status: 400 })
  const result = await createGroup(account.id, body.name, body.description ?? null)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
