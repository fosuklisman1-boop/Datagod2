import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const EMPTY = { join_community_link: "", join_group_link: "" }

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("join_community_link, join_group_link")
      .is("key", null)
      .single()

    if (error && error.code !== "PGRST116") {
      return NextResponse.json(EMPTY)
    }

    return NextResponse.json({
      join_community_link: data?.join_community_link ?? "",
      join_group_link: data?.join_group_link ?? "",
    })
  } catch {
    return NextResponse.json(EMPTY)
  }
}
