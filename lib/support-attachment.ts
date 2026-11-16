import type { SupabaseClient } from "@supabase/supabase-js"
import { isUuid } from "@/lib/support-validation"

export const SUPPORT_ATTACHMENT_BUCKET = "complaint-evidence"
export const SUPPORT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024
export const SUPPORT_ATTACHMENT_URL_TTL_SECONDS = 600

export type SniffedImage = { mime: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" }

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)

/** Identify an image from its magic bytes only. Never trust file.type or file.name. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: "image/webp", ext: "webp" }
  }
  return null
}

/** Storage path built from ids and a random name; the uploader's file name is never used. */
export function buildAttachmentPath(userId: string, threadId: string, ext: SniffedImage["ext"]): string {
  if (!isUuid(userId) || !isUuid(threadId)) throw new Error("attachment path needs UUID ids")
  return `threads/${userId}/${threadId}/${crypto.randomUUID()}.${ext}`
}

export async function storeThreadAttachment(
  db: SupabaseClient,
  args: { userId: string; threadId: string; file: File },
): Promise<{ path: string } | { error: "too_large" | "not_image" | "upload_failed" }> {
  const { userId, threadId, file } = args
  if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) return { error: "too_large" }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    console.error("[SUPPORT] attachment read failed", { userId, threadId })
    return { error: "upload_failed" }
  }
  // Re-check on the real bytes in case the declared size was wrong.
  if (bytes.byteLength > SUPPORT_ATTACHMENT_MAX_BYTES) return { error: "too_large" }
  const sniffed = sniffImage(bytes)
  if (!sniffed) return { error: "not_image" }
  let path: string
  try {
    path = buildAttachmentPath(userId, threadId, sniffed.ext)
  } catch {
    console.error("[SUPPORT] attachment path rejected", { userId, threadId })
    return { error: "upload_failed" }
  }
  try {
    const { error } = await db.storage.from(SUPPORT_ATTACHMENT_BUCKET).upload(path, bytes, { contentType: sniffed.mime, upsert: false })
    if (error) {
      console.error("[SUPPORT] attachment upload failed", { userId, threadId })
      return { error: "upload_failed" }
    }
  } catch {
    console.error("[SUPPORT] attachment upload threw", { userId, threadId })
    return { error: "upload_failed" }
  }
  return { path }
}

/** Short-lived signed URL, or null when there is no path or signing fails. */
export async function signAttachmentUrl(db: SupabaseClient, path: string | null): Promise<string | null> {
  if (!path) return null
  try {
    const { data, error } = await db.storage.from(SUPPORT_ATTACHMENT_BUCKET).createSignedUrl(path, SUPPORT_ATTACHMENT_URL_TTL_SECONDS)
    if (error || !data?.signedUrl) return null
    return data.signedUrl
  } catch {
    return null
  }
}

/** Best-effort removal in chunks of 100. Never throws. */
export async function removeAttachments(db: SupabaseClient, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 100) {
    try {
      const { error } = await db.storage.from(SUPPORT_ATTACHMENT_BUCKET).remove(paths.slice(i, i + 100))
      if (error) console.warn("[SUPPORT] attachment remove failed", { count: Math.min(100, paths.length - i) })
    } catch {
      console.warn("[SUPPORT] attachment remove threw")
    }
  }
}
