// Server-side intake for a shop logo that arrives as an embedded base64 image
// (the signup form reads the file in the browser and sends it as text). Embedded
// images used to be saved straight into user_shops.logo_url - up to 8 MB per row,
// copied into storefront pages. Now the server validates the image, stores it in
// the logo bucket and saves only the short public URL. Same rules as the dealer
// profile upload (lib/shop-logo.ts): JPG, PNG or WebP, 2 MB max, never SVG.
import type { SupabaseClient } from "@supabase/supabase-js"
import { LOGO_BUCKET, LOGO_MAX_BYTES } from "./shop-logo"
import { parseImageDataUri } from "./shop-logo-public"

const EXT_BY_TYPE: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }

export type LogoInput =
  | { kind: "none" }
  | { kind: "url"; url: string }
  | { kind: "image"; bytes: Buffer; contentType: string; ext: string }
  | { kind: "invalid"; error: string }

/** Classify a client-supplied logo value. Anything that isn't an embedded image passes through unchanged. */
export function checkLogoInput(value: string | null | undefined): LogoInput {
  const v = typeof value === "string" ? value.trim() : ""
  if (!v) return { kind: "none" }
  if (!v.startsWith("data:")) return { kind: "url", url: v }

  const parsed = parseImageDataUri(v)
  const ext = parsed ? EXT_BY_TYPE[parsed.contentType] : undefined
  if (!parsed || !ext) return { kind: "invalid", error: "Logo must be a JPG, PNG or WebP image" }
  if (parsed.bytes.length > LOGO_MAX_BYTES) return { kind: "invalid", error: "Logo must be 2 MB or smaller" }
  return { kind: "image", bytes: parsed.bytes, contentType: parsed.contentType, ext }
}

/** Upload a validated embedded logo under shop-logos/<shop id>/ and return its public URL. */
export async function storeEmbeddedLogo(
  client: SupabaseClient,
  shopId: string,
  img: Extract<LogoInput, { kind: "image" }>,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const path = `shop-logos/${shopId}/${Date.now()}.${img.ext}`
  const { error } = await client.storage.from(LOGO_BUCKET).upload(path, img.bytes, { contentType: img.contentType, upsert: false })
  if (error) {
    console.error("[SHOP-LOGO-INTAKE] storage upload failed:", (error as { message?: string }).message)
    return { ok: false, error: "Logo upload failed" }
  }
  return { ok: true, url: client.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl }
}
