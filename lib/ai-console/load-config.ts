import { AIProviderConfig, DEFAULT_CONFIG } from "@/lib/ai-provider-config"

// Shared by the chat route and the public assistant-profile route. 30s cache for good reads only.
// A read error yields defaults with failed=true and is NEVER cached, so the next call re-reads.
let configCache: { data: AIProviderConfig; ts: number } | null = null

export function resetAIConfigCache() { configCache = null }

export async function loadAIConfigChecked(client: { from: (t: string) => any }): Promise<{ config: AIProviderConfig; failed: boolean }> {
  if (configCache && Date.now() - configCache.ts < 30_000) return { config: configCache.data, failed: false }
  try {
    const { data, error } = await client.from("admin_settings").select("value").eq("key", "ai_provider_config").maybeSingle()
    if (error) return { config: DEFAULT_CONFIG, failed: true }
    const cfg: AIProviderConfig = (data?.value as AIProviderConfig) ?? DEFAULT_CONFIG
    configCache = { data: cfg, ts: Date.now() }
    return { config: cfg, failed: false }
  } catch {
    return { config: DEFAULT_CONFIG, failed: true }
  }
}

export async function loadAIConfig(client: { from: (t: string) => any }): Promise<AIProviderConfig> {
  return (await loadAIConfigChecked(client)).config
}
