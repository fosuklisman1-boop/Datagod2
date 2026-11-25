import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { AIProviderConfig, DEFAULT_CONFIG } from "@/lib/ai-provider-config"
import { assistantSettingsInputSchema, resolveAssistantSettings } from "@/lib/ai-console/settings"

export const dynamic = "force-dynamic"
export const revalidate = 0

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const SETTINGS_KEY = "ai_provider_config"

// Below this length 4 characters is too much of the key to show.
const MIN_MASKABLE_KEY_LENGTH = 16

function maskKey(key: unknown): string {
  const k = typeof key === "string" ? key.trim() : ""
  return k.length < MIN_MASKABLE_KEY_LENGTH ? "" : `ends in ${k.slice(-4)}`
}

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  const cfg: AIProviderConfig = (data?.value as AIProviderConfig) ?? {}

  const resolved = resolveAssistantSettings(cfg)
  const assistant = {
    assistant_name: resolved.name,
    tone: resolved.tone,
    audiences: resolved.audiences,
    max_tool_steps: resolved.maxToolSteps,
    admin_catalog_enabled: resolved.adminCatalog,
  }

  // Never return raw API keys to the client — return masked versions only
  return NextResponse.json({
    anthropic_api_key_masked: maskKey(cfg.anthropic_api_key),
    openai_api_key_masked: maskKey(cfg.openai_api_key),
    gemini_api_key_masked: maskKey(cfg.gemini_api_key),
    deepseek_api_key_masked: maskKey(cfg.deepseek_api_key),
    groq_api_key_masked: maskKey(cfg.groq_api_key),
    anthropic_key_set: !!(cfg.anthropic_api_key),
    openai_key_set: !!(cfg.openai_api_key),
    gemini_key_set: !!(cfg.gemini_api_key),
    deepseek_key_set: !!(cfg.deepseek_api_key),
    groq_key_set: !!(cfg.groq_api_key),
    storefront_provider: cfg.storefront_provider ?? DEFAULT_CONFIG.storefront_provider,
    storefront_model: cfg.storefront_model ?? DEFAULT_CONFIG.storefront_model,
    dashboard_provider: cfg.dashboard_provider ?? DEFAULT_CONFIG.dashboard_provider,
    dashboard_model: cfg.dashboard_model ?? DEFAULT_CONFIG.dashboard_model,
    admin_provider: cfg.admin_provider ?? DEFAULT_CONFIG.admin_provider,
    admin_model: cfg.admin_model ?? DEFAULT_CONFIG.admin_model,
    whatsapp_provider: cfg.whatsapp_provider ?? DEFAULT_CONFIG.whatsapp_provider,
    whatsapp_model: cfg.whatsapp_model ?? DEFAULT_CONFIG.whatsapp_model,
    ...assistant,
  })
}

export async function PUT(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json() as Partial<AIProviderConfig> & {
    // Frontend sends the key only when the user actually typed/changed it
    anthropic_api_key_new?: string
    openai_api_key_new?: string
    gemini_api_key_new?: string
    deepseek_api_key_new?: string
    groq_api_key_new?: string
  }

  // Assistant console settings: validated strictly before anything is written.
  const settingsInput: Record<string, unknown> = {}
  for (const k of ["assistant_name", "tone", "audiences", "max_tool_steps", "admin_catalog_enabled"] as const) {
    if ((body as Record<string, unknown>)[k] !== undefined) settingsInput[k] = (body as Record<string, unknown>)[k]
  }
  const parsedSettings = assistantSettingsInputSchema.safeParse(settingsInput)
  if (!parsedSettings.success) {
    return NextResponse.json({ error: "Invalid assistant settings" }, { status: 400 })
  }

  // Load existing config so we don't overwrite keys the user didn't touch
  const { data: existing } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle()

  const current: AIProviderConfig = (existing?.value as AIProviderConfig) ?? {}

  const updated: AIProviderConfig = {
    ...current,
    // Only overwrite keys when a new value was explicitly provided
    anthropic_api_key: body.anthropic_api_key_new !== undefined
      ? body.anthropic_api_key_new || current.anthropic_api_key
      : current.anthropic_api_key,
    openai_api_key: body.openai_api_key_new !== undefined
      ? body.openai_api_key_new || current.openai_api_key
      : current.openai_api_key,
    gemini_api_key: body.gemini_api_key_new !== undefined
      ? body.gemini_api_key_new || current.gemini_api_key
      : current.gemini_api_key,
    deepseek_api_key: body.deepseek_api_key_new !== undefined
      ? body.deepseek_api_key_new || current.deepseek_api_key
      : current.deepseek_api_key,
    groq_api_key: body.groq_api_key_new !== undefined
      ? body.groq_api_key_new || current.groq_api_key
      : current.groq_api_key,
    storefront_provider: body.storefront_provider ?? current.storefront_provider,
    storefront_model: body.storefront_model ?? current.storefront_model,
    dashboard_provider: body.dashboard_provider ?? current.dashboard_provider,
    dashboard_model: body.dashboard_model ?? current.dashboard_model,
    admin_provider: body.admin_provider ?? current.admin_provider,
    admin_model: body.admin_model ?? current.admin_model,
    whatsapp_provider: body.whatsapp_provider ?? current.whatsapp_provider,
    whatsapp_model: body.whatsapp_model ?? current.whatsapp_model,
    ...parsedSettings.data,
  }

  const { error } = await supabase
    .from("admin_settings")
    .upsert(
      { key: SETTINGS_KEY, value: updated, description: "AI provider configuration", updated_at: new Date().toISOString() },
      { onConflict: "key" }
    )

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
