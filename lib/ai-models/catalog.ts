// Priced model catalog for the AI Assistant console. Model ids mirror PROVIDER_MODELS exactly.
// Prices are USD per 1M tokens, copied from each provider's own pricing page on `checkedOn`.
// null = the official page did not list that model, so the UI says "Price not checked".
import type { ProviderName } from "@/lib/ai-provider-config"

export type ModelBadge = "Budget" | "Balanced" | "Recommended"

export interface CatalogModel {
  id: string
  label: string
  inUsdPerM: number | null
  outUsdPerM: number | null
  /** true only when the provider's own docs confirm tool use for this model. */
  tools: boolean
  badge?: ModelBadge
  description: string
  /** Extra line shown on the card (e.g. peak-pricing caveat). */
  note?: string
  checkedOn: string
  sourceUrl: string
}

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing"
const OPENAI = "https://developers.openai.com/api/docs/pricing"
const GEMINI = "https://aistudio.google.com/docs/pricing"
const DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing"
const GROQ = "https://console.groq.com/docs/models"
const DAY = "2026-11-21"
const PEAK_NOTE = "Off-peak price. Doubles on weekdays 01:00–04:00 and 06:00–10:00 UTC."

export const MODEL_CATALOG: Record<ProviderName, CatalogModel[]> = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", inUsdPerM: 1, outUsdPerM: 5, tools: true, badge: "Recommended",
      description: "Fast and cheap. A good default for everyday customer questions.", checkedOn: DAY, sourceUrl: ANTHROPIC },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", inUsdPerM: 3, outUsdPerM: 15, tools: true, badge: "Balanced",
      description: "Stronger reasoning for trickier questions, at a higher price.", checkedOn: DAY, sourceUrl: ANTHROPIC },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", inUsdPerM: 5, outUsdPerM: 25, tools: true,
      description: "Most capable of the three. Rarely needed for support chat.", checkedOn: DAY, sourceUrl: ANTHROPIC },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o Mini", inUsdPerM: 0.15, outUsdPerM: 0.6, tools: true, badge: "Budget",
      description: "Very low cost, fine for simple questions.", checkedOn: DAY, sourceUrl: OPENAI },
    { id: "gpt-4o", label: "GPT-4o", inUsdPerM: 2.5, outUsdPerM: 10, tools: true, badge: "Balanced",
      description: "A solid all-rounder.", checkedOn: DAY, sourceUrl: OPENAI },
    { id: "gpt-4.1", label: "GPT-4.1", inUsdPerM: 2, outUsdPerM: 8, tools: true,
      description: "Newer and a little cheaper than GPT-4o.", checkedOn: DAY, sourceUrl: OPENAI },
  ],
  gemini: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", inUsdPerM: null, outUsdPerM: null, tools: false,
      description: "Fast Google model. Not listed on Google's current price page.", checkedOn: DAY, sourceUrl: GEMINI },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro", inUsdPerM: null, outUsdPerM: null, tools: false,
      description: "Older Google model. Not listed on Google's current price page.", checkedOn: DAY, sourceUrl: GEMINI },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", inUsdPerM: 1.25, outUsdPerM: 10, tools: true,
      description: "Price shown is for prompts up to 200k tokens. Google lists it as deprecated.", checkedOn: DAY, sourceUrl: GEMINI },
  ],
  deepseek: [
    { id: "deepseek-flash", label: "DeepSeek Flash", inUsdPerM: 0.15, outUsdPerM: 0.6, tools: true, badge: "Recommended",
      description: "Current low-cost DeepSeek model.", note: PEAK_NOTE, checkedOn: DAY, sourceUrl: DEEPSEEK },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", inUsdPerM: 0.66, outUsdPerM: 1.98, tools: true, badge: "Balanced",
      description: "Stronger DeepSeek model for harder questions.", note: PEAK_NOTE, checkedOn: DAY, sourceUrl: DEEPSEEK },
    { id: "deepseek-chat", label: "DeepSeek Chat (legacy alias)", inUsdPerM: null, outUsdPerM: null, tools: false,
      description: "Older model name DeepSeek still accepts. Switch to DeepSeek Flash.", checkedOn: DAY, sourceUrl: DEEPSEEK },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner (legacy alias)", inUsdPerM: null, outUsdPerM: null, tools: false,
      description: "Older model name DeepSeek still accepts. Switch to DeepSeek Flash.", checkedOn: DAY, sourceUrl: DEEPSEEK },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", inUsdPerM: null, outUsdPerM: null, tools: false,
      description: "Open model on Groq. Price not published on the page we could read.", checkedOn: DAY, sourceUrl: GROQ },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", inUsdPerM: null, outUsdPerM: null, tools: false,
      description: "Small, very fast open model. Price not published on the page we could read.", checkedOn: DAY, sourceUrl: GROQ },
    { id: "gemma2-9b-it", label: "Gemma 2 9B", inUsdPerM: null, outUsdPerM: null, tools: false,
      description: "Small open model. Not on Groq's current model page.", checkedOn: DAY, sourceUrl: GROQ },
  ],
}

export function catalogFor(provider: ProviderName): CatalogModel[] {
  return MODEL_CATALOG[provider] ?? []
}

export const MESSAGE_TOKEN_ASSUMPTION = { inTokens: 3000, outTokens: 400 } as const

/** Estimated USD for 1,000 messages, or null if a price is unknown. */
export function costPer1000Messages(
  inUsdPerM: number | null,
  outUsdPerM: number | null,
  tokens: { inTokens: number; outTokens: number } = MESSAGE_TOKEN_ASSUMPTION,
): number | null {
  if (inUsdPerM === null || outUsdPerM === null) return null
  return (1000 * (tokens.inTokens * inUsdPerM + tokens.outTokens * outUsdPerM)) / 1_000_000
}

export function formatCostPer1000(cost: number | null): string {
  return cost === null ? "—" : `$${cost.toFixed(2)}`
}
