import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data } = await supabase
      .from("app_settings")
      .select("terms_content, terms_last_updated")
      .single()

    return NextResponse.json({
      terms_content: data?.terms_content ?? "",
      terms_last_updated: data?.terms_last_updated ?? null,
    })
  } catch {
    return NextResponse.json({ terms_content: "", terms_last_updated: null })
  }
}
