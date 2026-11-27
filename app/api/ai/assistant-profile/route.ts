import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { loadAIConfig } from "@/lib/ai-console/load-config"
import { resolveAssistantSettings } from "@/lib/ai-console/settings"
import { resolveVoiceSettings, voiceAvailable } from "@/lib/ai-voice/settings"

export const dynamic = "force-dynamic"

// Public, no auth: the name and which audiences have the assistant are the same for everyone. Config is read with the
// service role (never exposed); a read error falls back to defaults (assistant on, default name).
export async function GET() {
  let settings = resolveAssistantSettings(null)
  let voice = resolveVoiceSettings(null)
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const cfg = await loadAIConfig(supabase)
    settings = resolveAssistantSettings(cfg)
    voice = resolveVoiceSettings(cfg)
  } catch {
    // defaults
  }
  const voiceAvail = {
    public: voiceAvailable(voice, "public"),
    storefront: voiceAvailable(voice, "storefront"),
    dashboard: voiceAvailable(voice, "dashboard"),
    admin: voiceAvailable(voice, "admin"),
  }
  return NextResponse.json(
    { name: settings.name, audiences: settings.audiences, voice: voiceAvail },
    { headers: { "Cache-Control": "public, max-age=60" } }
  )
}
