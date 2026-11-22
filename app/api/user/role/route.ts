import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { rightsForUser } from "@/lib/roles/permissions-repo"
import { RoleReadError } from "@/lib/roles/repo"
import { hasGrant } from "@/lib/api-v2/store"

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
    // A per-person API access grant (admin-approved) shows the Developer page for a role without account.api.
    // UI only: every API route checks the grant itself. A failed read means no grant here.
    let apiGrant = false
    let list = rights.kind === "set" ? [...rights.caps] : null
    if (list && !list.includes("account.api")) {
      apiGrant = (await hasGrant(supabase, user.id)) === true
      if (apiGrant) list = [...list, "account.api"]
    }
    return NextResponse.json({
      slug,
      name: row?.name ?? slug,
      badge_color: row?.badge_color ?? null,
      icon: row?.icon ?? null,
      theme: { skin },
      rights: list ?? rights.kind,
      apiGrant,
    })
  } catch {
    return NextResponse.json({ error: "Couldn't load your role. Please try again." }, { status: 503 })
  }
}
