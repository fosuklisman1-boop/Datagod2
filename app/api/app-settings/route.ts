import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("join_community_link")
      .limit(1)
      .single()

    if (error && error.code !== "PGRST116") {
      return NextResponse.json({ join_community_link: "" })
    }

    return NextResponse.json({
      join_community_link: data?.join_community_link ?? "",
    })
  } catch {
    return NextResponse.json({ join_community_link: "" })
  }
}
