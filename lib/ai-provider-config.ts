// Client-safe constants and types — no SDK imports, safe to use in "use client" components.

export type ProviderName = "anthropic" | "openai" | "gemini" | "deepseek" | "groq"

export interface AIProviderConfig {
  anthropic_api_key?: string
  openai_api_key?: string
  gemini_api_key?: string
  deepseek_api_key?: string
  groq_api_key?: string
  storefront_provider?: ProviderName
  storefront_model?: string
  dashboard_provider?: ProviderName
  dashboard_model?: string
  admin_provider?: ProviderName
  admin_model?: string
}

export const PROVIDER_MODELS: Record<ProviderName, { id: string; label: string }[]> = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku (Fast)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet (Balanced)" },
    { id: "claude-opus-4-7", label: "Claude Opus (Powerful)" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o Mini (Fast)" },
    { id: "gpt-4o", label: "GPT-4o (Balanced)" },
    { id: "gpt-4.1", label: "GPT-4.1 (Powerful)" },
  ],
  gemini: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (Fast)" },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro (Balanced)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Powerful)" },
  ],
  deepseek: [
    { id: "deepseek-chat", label: "DeepSeek V3 (Fast)" },
    { id: "deepseek-reasoner", label: "DeepSeek R1 (Reasoning)" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Balanced)" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (Fast)" },
    { id: "gemma2-9b-it", label: "Gemma 2 9B (Fast)" },
  ],
}

export const DEFAULT_CONFIG: Required<Pick<
  AIProviderConfig,
  | "storefront_provider" | "storefront_model"
  | "dashboard_provider" | "dashboard_model"
  | "admin_provider"     | "admin_model"
>> = {
  storefront_provider: "anthropic",
  storefront_model: "claude-haiku-4-5-20251001",
  dashboard_provider: "anthropic",
  dashboard_model: "claude-haiku-4-5-20251001",
  admin_provider: "anthropic",
  admin_model: "claude-haiku-4-5-20251001",
}
