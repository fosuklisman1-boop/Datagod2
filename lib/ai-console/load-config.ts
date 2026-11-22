import { AIProviderConfig, DEFAULT_CONFIG } from "@/lib/ai-provider-config"

// Shared by the chat route and the public assistant-profile route. 30s cache; any read error -> defaults.
let configCache: { data: AIProviderConfig; ts: number } | null = null

export function resetAIConfigCache() { configCache = null }

export async function loadAIConfig(client: { from: (t: string) => any }): Promise<AIProviderConfig> {
  if (configCache && Date.now() - configCache.ts < 30_000) return configCache.data
  try {
    const { data } = await client.from("admin_settings").select("value").eq("key", "ai_provider_config").maybeSingle()
    const cfg: AIProviderConfig = (data?.value as AIProviderConfig) ?? DEFAULT_CONFIG
    configCache = { data: cfg, ts: Date.now() }
    return cfg
  } catch {
    return DEFAULT_CONFIG
  }
}
