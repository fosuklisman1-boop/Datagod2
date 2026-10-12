/**
 * Validate an admin-supplied SMS provider choice.
 * undefined/null/'' => undefined (no pick); 'moolre'|'hubtel'|'global' pass through;
 * anything else => 'invalid'.
 */
export function parseSmsProvider(v: unknown): "moolre" | "hubtel" | "global" | undefined | "invalid" {
  if (v === undefined || v === null || v === "") return undefined
  if (v === "moolre" || v === "hubtel" || v === "global") return v
  return "invalid"
}
