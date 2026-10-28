import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * main: DATAGOD's own USSD code (app_settings key `public_ussd_codes`, set on /admin/settings).
 * shop: the code customers dial to reach the "Enter shop code:" prompt, where they type their
 *       seller's 4-digit shop code (singleton app_settings row, column `ussd_shop_dial_code`,
 *       set on /admin/ussd-shops). The 4-digit code is entered at the prompt, never appended.
 */
export type PublicUssdCodes = { main: string | null; shop: string | null }

export const USSD_CODE_RE = /^\*\d{2,4}(\*\d{1,12})*#$/
const MAX_LEN = 30

export const PUBLIC_USSD_SETTING_KEY = "public_ussd_codes"

/** undefined = invalid, null = cleared/absent */
function cleanCode(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== "string") return undefined
  const t = v.trim()
  if (t === "") return null
  if (t.length > MAX_LEN || !USSD_CODE_RE.test(t)) return undefined
  return t
}

/** The stored `public_ussd_codes` value ({ main }) to a valid main code or null. */
export function parseMainUssdCode(raw: unknown): string | null {
  let obj: unknown = raw
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  return cleanCode((obj as Record<string, unknown>).main) ?? null
}

export function validateUssdCodesInput(
  body: unknown,
): { ok: true; value: { main: string | null } } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid request body" }
  const main = cleanCode((body as Record<string, unknown>).main)
  if (main === undefined) return { ok: false, error: "Main code must look like *920# (digits, * and # only)" }
  return { ok: true, value: { main } }
}

/** Throws on a DB error. Use where a silent empty result would be harmful (admin editor, cached facts). */
export async function readPublicUssdCodes(db: SupabaseClient): Promise<PublicUssdCodes> {
  const [mainRes, shopRes] = await Promise.all([
    db.from("app_settings").select("value").eq("key", PUBLIC_USSD_SETTING_KEY).maybeSingle(),
    // Same singleton row app/api/admin/ussd-shops/route.ts reads; no '*426*203#' default here,
    // so the website never advertises a code the admin didn't set.
    db.from("app_settings").select("ussd_shop_dial_code").is("key", null).limit(1).maybeSingle(),
  ])
  if (mainRes.error) throw new Error(`Failed to read public USSD codes: ${mainRes.error.message}`)
  if (shopRes.error) throw new Error(`Failed to read shop dial code: ${shopRes.error.message}`)
  return {
    main: parseMainUssdCode((mainRes.data as { value?: unknown } | null)?.value),
    shop: cleanCode((shopRes.data as { ussd_shop_dial_code?: unknown } | null)?.ussd_shop_dial_code) ?? null,
  }
}

/** Public-site reader: a DB error degrades to "no codes shown". */
export async function getPublicUssdCodes(db: SupabaseClient): Promise<PublicUssdCodes> {
  try {
    return await readPublicUssdCodes(db)
  } catch {
    return { main: null, shop: null }
  }
}
