import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { rightsForUser } from "@/lib/roles/permissions-repo"
import { RoleReadError } from "@/lib/roles/repo"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/user/role
 * The caller's role display info, skin and rights. 503 (never defaults) when rights cannot be read.
 */
export async function GET(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { slug, rights } = await rightsForUser(supabase, user.id)
    const { data: row, error } = await supabase
      .from("roles")
      .select("name, badge_color, icon, theme")
      .eq("slug", slug)
      .maybeSingle()
    if (error) throw new RoleReadError()
    const skin = row?.theme?.skin === "dealer" ? "dealer" : "default"
    return NextResponse.json({
      slug,
      name: row?.name ?? slug,
      badge_color: row?.badge_color ?? null,
      icon: row?.icon ?? null,
      theme: { skin },
      rights: rights.kind === "set" ? [...rights.caps] : rights.kind,
    })
  } catch {
    return NextResponse.json({ error: "Couldn't load your role. Please try again." }, { status: 503 })
  }
}
