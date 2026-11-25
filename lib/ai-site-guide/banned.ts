/**
 * Words that must never appear in help articles for non-admin audiences.
 *
 * Supplier brand names come from the fulfilment provider code and are never shown to customers:
 * - lib/mtn-providers/provider-display.ts (PROVIDER_DISPLAY labels and keys): sykes, datakazina, xpress, eazyghdata,
 *   bisdel, codecraft, agentportalgh, apexprime, spfastit, bundleportal, kuntanii, hubnet
 * - lib/mtn-providers/types.ts + factory.ts (MTNProviderName / NonMTNProviderName): same names plus spfastit_telecel
 * - lib/digiwapy-provider.ts and lib/airtime-provider.ts (airtime supplier): digiwapy
 * - lib/sykes-afa-provider.ts (AFA supplier): sykes
 * Spaced spellings (data kazina, apex prime, ...) are listed too so prose cannot slip past.
 *
 * Payment gateways and providers customers DO see are deliberately not listed: Paystack (reference, "Secured by"),
 * Hubtel (fee note), Moolre (shown to shop owners on the withdraw page and in the SMS provider picker).
 * The risk words come from the article brief: fraud, threshold, blacklist, velocity, risk score.
 */
export const BANNED_FOR_NON_ADMIN: string[] = [
  // Risk and abuse wording
  "fraud",
  "fraudulent",
  "threshold",
  "thresholds",
  "blacklist",
  "blacklisted",
  "blacklisting",
  "velocity",
  "risk score",
  // Supplier brand names (see the source list above)
  "sykes",
  "datakazina",
  "data kazina",
  "xpress",
  "eazyghdata",
  "eazygh data",
  "bisdel",
  "codecraft",
  "code craft",
  "agentportalgh",
  "agentportal",
  "agent portal",
  "apexprime",
  "apex prime",
  "spfastit",
  "sp fast it",
  "spfastit_telecel",
  "bundleportal",
  "bundle portal",
  "kuntanii",
  "hubnet",
  "digiwapy",
  // SMS / email vendors (lib/mnotify-sender-id.ts, lib/sms-service.ts, lib/email-service.ts); customers never see them.
  // "resend" is NOT listed: it is an everyday button word on checkout and sign-up pages.
  "mnotify",
  "brevo",
  // AI vendors and models (lib/ai-provider-config.ts ProviderName)
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "groq",
  "claude",
  // Infrastructure vendors
  "supabase",
  "vercel",
  "upstash",
]

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** One case-insensitive whole-word matcher per term; spaces in a term match any run of whitespace. */
const MATCHERS: { term: string; re: RegExp }[] = BANNED_FOR_NON_ADMIN.map((term) => ({
  term,
  re: new RegExp(`(?<![a-z0-9_])${term.split(/\s+/).map(escapeRegex).join("\\s+")}(?![a-z0-9_])`, "i"),
}))

/** Banned terms found in `text` (lowercase, each once, in list order). Whole words only, so "express" never trips "xpress". */
export function bannedHits(text: string): string[] {
  const out: string[] = []
  for (const { term, re } of MATCHERS) if (re.test(text)) out.push(term)
  return out
}
