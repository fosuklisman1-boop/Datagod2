import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import {
  getContactVerifyProgress,
  processContactVerifyChunk,
  markContactsForVerification,
} from "@/lib/sms/contact-verify-service"

// GET /api/sms/contacts/verify?groupId=... — verification progress (counts)
export async function GET(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const groupId = request.nextUrl.searchParams.get("groupId") || undefined
  const result = await getContactVerifyProgress(account.id, groupId)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}

// POST /api/sms/contacts/verify — process ONE chunk (client polls until remaining=0).
//   { groupId?, reverify? }  reverify=true re-queues already-checked contacts first.
export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  let body: { groupId?: string; reverify?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    // body is optional for this endpoint
  }
  const groupId = body.groupId || undefined

  if (body.reverify === true) {
    const marked = await markContactsForVerification(account.id, groupId)
    if (!marked.ok) return NextResponse.json({ success: false, error: marked.error }, { status: 404 })
  }

  const result = await processContactVerifyChunk(account.id, groupId)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}
