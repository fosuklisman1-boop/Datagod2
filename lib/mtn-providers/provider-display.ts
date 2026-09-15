/**
 * Single source of truth for how a provider name renders in the UI (label +
 * badge color) — used anywhere a raw `mtn_fulfillment_tracking.provider`
 * string needs to become something a human reads.
 *
 * Root cause this closes: app/admin/mtn-logs/page.tsx used to render this
 * with a hardcoded if/else-if chain whose final `else` branch showed a
 * "Sykes" badge for ANY unmatched provider string — so every SPFastIT and
 * Bundle Portal row displayed as "Sykes" even though the underlying
 * `provider` column was always correct. Adding a new provider to THIS map is
 * now the only change needed for every consumer to display it correctly —
 * there is deliberately no per-provider branch anywhere else to forget.
 */
export const PROVIDER_DISPLAY: Record<string, { label: string; badgeClassName: string }> = {
  sykes: { label: "Sykes", badgeClassName: "bg-primary/10 text-primary border-primary/20" },
  datakazina: { label: "DataKazina", badgeClassName: "bg-success/15 text-success border-border" },
  xpress: { label: "Xpress", badgeClassName: "bg-primary/10 text-primary border-border" },
  eazyghdata: { label: "EazyGhData", badgeClassName: "bg-primary/10 text-primary border-border" },
  bisdel: { label: "Bisdel", badgeClassName: "bg-primary/10 text-primary border-border" },
  codecraft: { label: "CodeCraft", badgeClassName: "bg-violet-100 text-violet-800 border-border" },
  agentportalgh: { label: "AgentPortalGH", badgeClassName: "bg-amber-100 text-amber-800 border-border" },
  apexprime: { label: "Apex Prime", badgeClassName: "bg-cyan-100 text-cyan-800 border-border" },
  spfastit: { label: "SPFastIT", badgeClassName: "bg-fuchsia-100 text-fuchsia-800 border-border" },
  bundleportal: { label: "Bundle Portal", badgeClassName: "bg-sky-100 text-sky-800 border-border" },
}

const UNKNOWN_DISPLAY = { label: "Unknown", badgeClassName: "bg-muted text-muted-foreground border-border" }

/**
 * Resolve a raw provider string to its display label + badge class.
 * - Missing/empty/null → "Unknown" (never a specific provider's label).
 * - Recognized → its real entry from PROVIDER_DISPLAY.
 * - Anything else (a provider added to the DB/dispatch layer but not yet to
 *   this map) → the raw value itself, capitalization untouched, so it's
 *   immediately visible as "not yet styled" rather than silently wrong.
 */
export function getProviderDisplay(provider: string | null | undefined): { label: string; badgeClassName: string } {
  if (!provider) return UNKNOWN_DISPLAY
  return PROVIDER_DISPLAY[provider] ?? { label: provider, badgeClassName: "bg-muted text-foreground border-border" }
}
