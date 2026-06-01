import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Public endpoint to expose global feature toggles to the frontend.
// Uses the service-role client because app_settings is locked down to
// service_role only (RLS). This route reads server-side and returns ONLY
// the curated public toggle fields below — no sensitive columns reach the
// browser. The anon client would get `42501 permission denied` here.
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("app_settings")
      .select("signups_enabled, wallet_topups_enabled, upgrades_enabled, ordering_enabled, join_community_link, announcement_enabled, announcement_title, announcement_message, storefront_announcement_enabled, storefront_announcement_title, storefront_announcement_message")
      .single()

    const fallback = {
      signups_enabled: true,
      wallet_topups_enabled: true,
      upgrades_enabled: true,
      ordering_enabled: true,
      join_community_link: "",
      announcement_enabled: false,
      announcement_title: "",
      announcement_message: "",
      storefront_announcement_enabled: false,
      storefront_announcement_title: "",
      storefront_announcement_message: "",
    }

    if (error) {
      console.error("[PUBLIC_SETTINGS] Database error:", error)
      return NextResponse.json(fallback)
    }

    return NextResponse.json({
      signups_enabled: data?.signups_enabled ?? true,
      wallet_topups_enabled: data?.wallet_topups_enabled ?? true,
      upgrades_enabled: data?.upgrades_enabled ?? true,
      ordering_enabled: data?.ordering_enabled ?? true,
      join_community_link: data?.join_community_link ?? "",
      announcement_enabled: data?.announcement_enabled ?? false,
      announcement_title: data?.announcement_title ?? "",
      announcement_message: data?.announcement_message ?? "",
      storefront_announcement_enabled: data?.storefront_announcement_enabled ?? false,
      storefront_announcement_title: data?.storefront_announcement_title ?? "",
      storefront_announcement_message: data?.storefront_announcement_message ?? "",
    })
  } catch (error) {
    console.error("[PUBLIC_SETTINGS] Internal error:", error)
    return NextResponse.json({
      signups_enabled: true,
      wallet_topups_enabled: true,
      upgrades_enabled: true,
      ordering_enabled: true,
      join_community_link: "",
      announcement_enabled: false,
      announcement_title: "",
      announcement_message: "",
      storefront_announcement_enabled: false,
      storefront_announcement_title: "",
      storefront_announcement_message: "",
    })
  }
}
