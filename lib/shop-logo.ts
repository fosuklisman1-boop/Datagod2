// Dealer shop-logo upload, done server-side with the service key. The `admin-uploads` storage
// bucket only lets role=admin users insert (storage RLS), so a direct browser upload from the
// dealer Shop Profile page failed with "new row violates row-level security policy". The caller's
// own shop is looked up from their user id (never a client-supplied shop id), so a dealer can
// only ever write under shop-logos/<their shop id>/.
import type { SupabaseClient } from "@supabase/supabase-js"

export const LOGO_BUCKET = "admin-uploads"
export const LOGO_MAX_BYTES = 2 * 1024 * 1024

// No SVG: it can carry scripts and is served from a public bucket.
const EXT_BY_TYPE: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }

export interface LogoFileLike {
  type: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export function validateLogoFile(file: { type: string; size: number }): { ok: true; ext: string } | { ok: false; error: string } {
  const ext = EXT_BY_TYPE[file.type]
  if (!ext) return { ok: false, error: "Logo must be a JPG, PNG or WebP image" }
  if (!(file.size > 0)) return { ok: false, error: "The logo file is empty" }
  if (file.size > LOGO_MAX_BYTES) return { ok: false, error: "Logo must be 2 MB or smaller" }
  return { ok: true, ext }
}

export type UploadShopLogoResult = { ok: true; url: string } | { ok: false; status: number; error: string }

export async function uploadShopLogo(
  client: SupabaseClient,
  { userId, file }: { userId: string; file: LogoFileLike },
): Promise<UploadShopLogoResult> {
  const valid = validateLogoFile(file)
  if (!valid.ok) return { ok: false, status: 400, error: valid.error }

  const { data: shop, error: shopError } = await client.from("user_shops").select("id").eq("user_id", userId).maybeSingle()
  if (shopError) {
    console.error("[SHOP-LOGO] shop lookup failed:", (shopError as { message?: string }).message)
    return { ok: false, status: 500, error: "Logo upload failed" }
  }
  if (!shop) return { ok: false, status: 404, error: "Shop not found" }

  const path = `shop-logos/${(shop as { id: string }).id}/${Date.now()}.${valid.ext}`
  const bytes = Buffer.from(await file.arrayBuffer())
  const { error: uploadError } = await client.storage.from(LOGO_BUCKET).upload(path, bytes, { contentType: file.type, upsert: false })
  if (uploadError) {
    console.error("[SHOP-LOGO] storage upload failed:", (uploadError as { message?: string }).message)
    return { ok: false, status: 500, error: "Logo upload failed" }
  }
  const { data } = client.storage.from(LOGO_BUCKET).getPublicUrl(path)
  return { ok: true, url: data.publicUrl }
}
