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
      .select("terms_content, terms_content_data, terms_content_airtime, terms_content_results_checker, terms_content_bulk_sms, terms_last_updated")
      .is("key", null)
      .single()

    return NextResponse.json({
      terms_content: data?.terms_content ?? "",
      terms_content_data: data?.terms_content_data ?? "",
      terms_content_airtime: data?.terms_content_airtime ?? "",
      terms_content_results_checker: data?.terms_content_results_checker ?? "",
      terms_content_bulk_sms: data?.terms_content_bulk_sms ?? "",
      terms_last_updated: data?.terms_last_updated ?? null,
    })
  } catch {
    return NextResponse.json({
      terms_content: "",
      terms_content_data: "",
      terms_content_airtime: "",
      terms_content_results_checker: "",
      terms_content_bulk_sms: "",
      terms_last_updated: null,
    })
  }
}
