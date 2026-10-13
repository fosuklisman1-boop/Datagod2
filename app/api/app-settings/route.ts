import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { ghanaSignificant } from "@/lib/phone-format"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// wa.me needs international digits (233XXXXXXXXX); "" when unset/invalid.
const toWaDigits = (n: string | null | undefined) => {
  const sig = ghanaSignificant(n || "")
  return sig ? "233" + sig : ""
}

const EMPTY = { join_community_link: "", join_group_link: "", whatsapp_bot_number: "" }

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("join_community_link, join_group_link, whatsapp_bot_number")
      .is("key", null)
      .single()

    if (error && error.code !== "PGRST116") {
      return NextResponse.json(EMPTY)
    }

    return NextResponse.json({
      join_community_link: data?.join_community_link ?? "",
      join_group_link: data?.join_group_link ?? "",
      whatsapp_bot_number: toWaDigits(data?.whatsapp_bot_number),
    })
  } catch {
    return NextResponse.json(EMPTY)
  }
}
