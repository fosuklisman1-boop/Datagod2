import { isMissingColumn } from "./provider-override"

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

export const SMS_PROVIDER_MIGRATION_MESSAGE = "Apply migration 20261020 (sms_provider column) before choosing a provider"

/** The readable 409 message when an explicit provider pick hit a missing broadcast_logs.sms_provider column; else null. */
export function providerColumnMissingMessage(
  err: { code?: string; message?: string } | null | undefined,
  smsProvider: unknown,
): string | null {
  if (!err || (smsProvider !== "moolre" && smsProvider !== "hubtel")) return null
  return isMissingColumn(err) ? SMS_PROVIDER_MIGRATION_MESSAGE : null
}
