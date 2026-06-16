import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { deleteTenantTemplate } from "@/lib/sms/tenant-templates-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// DELETE /api/sms/templates/[id] — delete one of the caller's own templates
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ success: false, error: "No SMS account for this user" }, { status: 403 })

  const { id } = await params
  const result = await deleteTenantTemplate(account.id, id)
  if (!result.ok) {
    const status = result.error === "Template not found" ? 404 : 500
    return NextResponse.json({ success: false, error: result.error }, { status })
  }
  return NextResponse.json({ success: true, data: result.data })
}
