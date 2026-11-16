/**
 * The one reader of the phone link env: SMS_PHONE_URL (an http(s) URL) and SMS_PHONE_SM4_KEY (32 hex chars).
 * Pure and import-free (no node:crypto) so the admin read-model can use it. The values never leave the server.
 */
export function readPhoneLink(env: Record<string, string | undefined>): { url: string; keyHex: string } | null {
  const url = typeof env.SMS_PHONE_URL === "string" ? env.SMS_PHONE_URL.trim() : ""
  const keyHex = typeof env.SMS_PHONE_SM4_KEY === "string" ? env.SMS_PHONE_SM4_KEY.trim() : ""
  if (!/^[0-9a-fA-F]{32}$/.test(keyHex)) return null
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) return null
  } catch {
    return null
  }
  return { url, keyHex }
}
