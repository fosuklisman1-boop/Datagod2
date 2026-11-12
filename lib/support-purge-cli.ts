export const PURGE_CONFIRM_VALUE = "DELETE-RESOLVED-COMPLAINTS"

export const PURGE_USAGE = "usage: npx tsx scripts/purge-resolved-complaints.ts [--apply]   (dry run unless --apply; --apply also needs PURGE_CONFIRM)"

/**
 * Decides what the purge script may do. Dry run is the default and has no flag; the only way to delete
 * is the exact argument `--apply` together with PURGE_CONFIRM set to the exact confirmation string.
 * Anything else is an error, so a typo can never fall through to a delete.
 */
export function parsePurgeArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): { mode: "dry" | "apply" } | { error: string } {
  if (argv.length === 0) return { mode: "dry" }
  if (argv.length > 1 || argv[0] !== "--apply") return { error: PURGE_USAGE }
  if (env.PURGE_CONFIRM !== PURGE_CONFIRM_VALUE) {
    return { error: `--apply requires the environment variable PURGE_CONFIRM to equal ${PURGE_CONFIRM_VALUE}` }
  }
  return { mode: "apply" }
}
