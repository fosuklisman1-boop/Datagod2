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

/**
 * Decide the per-send provider override for a bulk send.
 * Invalid/'global'/''/garbage => undefined (use routing). Admin => the requested provider.
 * Non-admin => the requested provider ONLY when tenant choice is enabled; otherwise silently
 * ignored (never an error, so the setting does not leak).
 */
export function resolveSendProvider(args: {
  requested: unknown
  isAdmin: boolean
  tenantChoiceEnabled: boolean
}): "moolre" | "hubtel" | undefined {
  const r = args.requested
  if (r !== "moolre" && r !== "hubtel") return undefined
  if (args.isAdmin) return r
  return args.tenantChoiceEnabled ? r : undefined
}
