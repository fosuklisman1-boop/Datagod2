// Public delivery of shop logos stored as embedded base64 data URIs.
//
// ~600 legacy shops keep their logo as a `data:image/...;base64,...` string in
// user_shops.logo_url (up to 8 MB). The storefront used to copy that string into
// the page HTML several times (icons, link preview, props), so a single page view
// weighed megabytes. New uploads go to Storage (lib/shop-logo.ts) and are plain
// URLs; this module only handles the legacy embedded ones.

// Raster formats only. SVG is deliberately NOT served: it can carry scripts
// (lib/shop-logo.ts refuses SVG uploads for the same reason). HEIC isn't
// displayable by most browsers.
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()

export type ParsedImage = { contentType: string; bytes: Buffer }

// The real format, from the file's own header - the data URI label is only a claim
// (some stored logos are WebP labelled PNG, and a label can say anything).
function detectImageType(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("latin1", 0, 6))) return "image/gif"
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp"
  return null
}

/**
 * Decode a `data:image/<png|jpeg|webp|gif>;base64,...` string. The returned type comes
 * from the bytes themselves; null if the label isn't an allowed raster type or the
 * bytes aren't a real JPEG/PNG/WebP/GIF.
 */
export function parseImageDataUri(value: string): ParsedImage | null {
  const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]*)$/i.exec(value ?? "")
  if (!m) return null
  if (!ALLOWED_TYPES.has(m[1].toLowerCase())) return null
  const bytes = Buffer.from(m[2], "base64")
  const contentType = detectImageType(bytes)
  if (!contentType) return null
  return { contentType, bytes }
}

// Cheap change-detector for cache busting: length + head + tail + a sparse
// sample. Hashing all 8 MB on every storefront request would be wasteful.
function logoVersion(logo: string): string {
  let h = 2166136261
  const mix = (code: number) => {
    h ^= code
    h = Math.imul(h, 16777619) >>> 0
  }
  for (let i = 0; i < Math.min(64, logo.length); i++) mix(logo.charCodeAt(i))
  for (let i = Math.max(0, logo.length - 64); i < logo.length; i++) mix(logo.charCodeAt(i))
  for (let i = 0; i < logo.length; i += 4096) mix(logo.charCodeAt(i))
  return `${logo.length.toString(36)}-${h.toString(36)}`
}

/**
 * What to put in a page for a shop's logo: a normal URL stays as is; an embedded
 * data URI becomes a short absolute URL served (and CDN-cached) by
 * /api/shop-logo/[slug]. Absolute so it also works in Open Graph / icon tags.
 */
export function shopLogoPublicUrl(slug: string, logo: string | null | undefined): string | null {
  const value = logo?.trim()
  if (!value) return null
  if (!value.startsWith("data:")) return value
  return `https://www.${ROOT_DOMAIN}/api/shop-logo/${encodeURIComponent(slug)}?v=${logoVersion(value)}`
}
