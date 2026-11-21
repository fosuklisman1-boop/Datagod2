import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { loadAIConfig } from "@/lib/ai-console/load-config"
import { resolveAssistantSettings } from "@/lib/ai-console/settings"

// Public, no auth: the name and which audiences have the assistant are the same for everyone. Config is read with the
// service role (never exposed); a read error falls back to defaults (assistant on, default name).
export async function GET() {
  let settings = resolveAssistantSettings(null)
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    settings = resolveAssistantSettings(await loadAIConfig(supabase))
  } catch {
    // defaults
  }
  return NextResponse.json(
    { name: settings.name, audiences: settings.audiences },
    { headers: { "Cache-Control": "public, max-age=60" } }
  )
}
