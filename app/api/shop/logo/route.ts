import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { uploadShopLogo } from "@/lib/shop-logo"

// POST /api/shop/logo — multipart form with `file`. The dealer's own shop logo is uploaded with the
// service key because storage RLS on `admin-uploads` only lets admins insert (see lib/shop-logo.ts).
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(authHeader.substring(7))
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let file: FormDataEntryValue | null
  try {
    file = (await request.formData()).get("file")
  } catch {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 })
  }
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "No logo file received" }, { status: 400 })
  }

  const result = await uploadShopLogo(supabaseAdmin, { userId: user.id, file })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ url: result.url })
}
