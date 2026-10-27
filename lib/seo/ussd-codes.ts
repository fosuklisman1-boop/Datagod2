import type { SupabaseClient } from "@supabase/supabase-js"

export type PublicUssdCodes = { main: string | null; shop: string | null }

export const USSD_CODE_RE = /^\*\d{2,4}(\*[0-9A-Za-z]{1,12})*#$/
const NUMERIC_ONLY_RE = /^[0-9*#]+$/
const MAX_LEN = 30

export const PUBLIC_USSD_SETTING_KEY = "public_ussd_codes"

function cleanField(field: "main" | "shop", v: unknown): string | null | undefined {
  // undefined = invalid, null = cleared
  if (v === undefined || v === null) return null
  if (typeof v !== "string") return undefined
  const t = v.trim()
  if (t === "") return null
  if (t.length > MAX_LEN || !USSD_CODE_RE.test(t)) return undefined
  // The SHOPCODE placeholder (letters) belongs only in the shop format.
  if (field === "main" && !NUMERIC_ONLY_RE.test(t)) return undefined
  return t
}

export function parseUssdCodes(raw: unknown): PublicUssdCodes {
  let obj: unknown = raw
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw)
    } catch {
      return { main: null, shop: null }
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { main: null, shop: null }
  const o = obj as Record<string, unknown>
  return { main: cleanField("main", o.main) ?? null, shop: cleanField("shop", o.shop) ?? null }
}

export function validateUssdCodesInput(
  body: unknown,
): { ok: true; value: PublicUssdCodes } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid request body" }
  const o = body as Record<string, unknown>
  const main = cleanField("main", o.main)
  if (main === undefined) return { ok: false, error: "Main code must look like *920# (digits, * and # only)" }
  const shop = cleanField("shop", o.shop)
  if (shop === undefined) return { ok: false, error: "Shop code must look like *920*SHOPCODE#" }
  return { ok: true, value: { main, shop } }
}

export async function getPublicUssdCodes(db: SupabaseClient): Promise<PublicUssdCodes> {
  const { data, error } = await db
    .from("app_settings")
    .select("value")
    .eq("key", PUBLIC_USSD_SETTING_KEY)
    .maybeSingle()
  if (error) return { main: null, shop: null }
  return parseUssdCodes(data?.value)
}
