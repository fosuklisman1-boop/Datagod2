/**
 * One-off: move legacy embedded (base64 data URI) shop logos out of user_shops.logo_url into
 * Supabase Storage and store the short public URL instead.
 *
 *   npx tsx scripts/migrate-shop-logos.ts                    DRY RUN (default): decodes + resizes in memory, writes NOTHING
 *   npx tsx scripts/migrate-shop-logos.ts --apply [--limit N]  backup -> upload -> verify -> update, one shop at a time
 *   npx tsx scripts/migrate-shop-logos.ts --rollback <file>    restore logo_url from a backup file
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (never printed).
 *
 * Safety:
 *  - only rows whose logo_url STARTS WITH 'data:' are touched; the update is conditional on that, so a
 *    shop owner who uploaded a new logo in the meantime is never overwritten
 *  - the original data URI is appended to the backup file BEFORE any write
 *  - the uploaded image is fetched back from its public URL and its size checked before the row is updated
 *  - logos are resized to fit 512x512 (they display at <= 64px); JPEG stays JPEG, everything else becomes PNG
 *  - only real JPEG/PNG/WebP/GIF files (checked by file header) are migrated; anything else is skipped and reported
 */
import { createClient } from "@supabase/supabase-js"
import sharp from "sharp"
import fs from "fs"
import { parseImageDataUri } from "../lib/shop-logo-public"
import { LOGO_BUCKET } from "../lib/shop-logo"

const MAX_SIDE = 512
const KEEP_ORIGINAL_UNDER = 150 * 1024

type Prepared =
  | { ok: true; bytes: Buffer; contentType: string; ext: string; origBytes: number; note: string }
  | { ok: false; reason: string }

export async function prepareLogo(dataUri: string): Promise<Prepared> {
  const parsed = parseImageDataUri(dataUri)
  if (!parsed) return { ok: false, reason: "not a valid JPEG/PNG/WebP/GIF data URI" }
  let meta: sharp.Metadata
  try {
    meta = await sharp(parsed.bytes, { limitInputPixels: 100_000_000 }).metadata()
  } catch (e) {
    return { ok: false, reason: `unreadable image: ${(e as Error).message.slice(0, 80)}` }
  }
  const small = Math.max(meta.width ?? 0, meta.height ?? 0) <= MAX_SIDE
  const ext0 = parsed.contentType === "image/jpeg" ? "jpg" : parsed.contentType === "image/png" ? "png" : parsed.contentType === "image/webp" ? "webp" : null
  if (small && parsed.bytes.length <= KEEP_ORIGINAL_UNDER && ext0) {
    return { ok: true, bytes: parsed.bytes, contentType: parsed.contentType, ext: ext0, origBytes: parsed.bytes.length, note: "kept as is" }
  }
  try {
    const pipeline = sharp(parsed.bytes, { limitInputPixels: 100_000_000 }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    if (parsed.contentType === "image/jpeg") {
      const out = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer()
      return { ok: true, bytes: out, contentType: "image/jpeg", ext: "jpg", origBytes: parsed.bytes.length, note: "resized jpeg" }
    }
    const out = await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer()
    return { ok: true, bytes: out, contentType: "image/png", ext: "png", origBytes: parsed.bytes.length, note: "resized png" }
  } catch (e) {
    // e.g. a corrupt JPEG that passes the header check but can't be decoded: leave that shop untouched.
    return { ok: false, reason: `could not resize: ${(e as Error).message.slice(0, 80)}` }
  }
}

const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const args = process.argv.slice(2)

  if (args.includes("--rollback")) {
    const file = args[args.indexOf("--rollback") + 1]
    if (!file || !fs.existsSync(file)) throw new Error("--rollback needs an existing backup file path")
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    let restored = 0
    for (const line of lines) {
      const { id, logo_url } = JSON.parse(line) as { id: string; logo_url: string }
      const { error } = await db.from("user_shops").update({ logo_url }).eq("id", id)
      if (error) console.error("rollback failed for", id, error.message)
      else restored++
    }
    console.log(`rolled back ${restored}/${lines.length} shops`)
    return
  }

  const apply = args.includes("--apply")
  const limitArg = args.indexOf("--limit")
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity

  // ids first (small payload), then each logo one at a time
  // Filtering on the multi-MB logo_url column through PostgREST hits the 8s statement timeout, so the
  // id list is produced separately (admin SQL: select id, shop_slug, is_active from user_shops where
  // logo_url like 'data:%' order by id) and handed in as a JSON file.
  const idsFile = process.env.LOGO_IDS_FILE
  if (!idsFile || !fs.existsSync(idsFile)) throw new Error("LOGO_IDS_FILE (JSON array of {id, shop_slug, is_active}) is required")
  const ids: { id: string; shop_slug: string; is_active: boolean }[] = JSON.parse(fs.readFileSync(idsFile, "utf8"))
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${ids.length} shops with an embedded logo`)

  const backupFile = apply ? `backups/shop-logos-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl` : null
  if (backupFile) {
    fs.mkdirSync("backups", { recursive: true })
    console.log("backup file:", backupFile)
  }

  let done = 0, skipped = 0, failed = 0, origTotal = 0, newTotal = 0
  const skips: string[] = []
  let processed = 0
  for (const row of ids) {
    if (processed >= limit) break
    processed++
    const { data, error } = await db.from("user_shops").select("logo_url").eq("id", row.id).single()
    const original = (data as { logo_url?: string } | null)?.logo_url
    if (error || !original || !original.startsWith("data:")) { skipped++; skips.push(`${row.shop_slug}: changed or unreadable`); continue }

    const prep = await prepareLogo(original)
    if (!prep.ok) { skipped++; skips.push(`${row.shop_slug}: ${prep.reason}`); continue }
    origTotal += prep.origBytes
    newTotal += prep.bytes.length

    if (!apply) { done++; continue }

    fs.appendFileSync(backupFile!, JSON.stringify({ id: row.id, shop_slug: row.shop_slug, logo_url: original }) + "\n")
    const path = `shop-logos/${row.id}/${Date.now()}.${prep.ext}`
    const up = await db.storage.from(LOGO_BUCKET).upload(path, prep.bytes, { contentType: prep.contentType, upsert: false })
    if (up.error) { failed++; console.error(`upload failed ${row.shop_slug}: ${up.error.message}`); continue }
    const publicUrl = db.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl
    const check = await fetch(publicUrl)
    const got = Buffer.from(await check.arrayBuffer())
    if (!check.ok || got.length !== prep.bytes.length) { failed++; console.error(`verify failed ${row.shop_slug}: status ${check.status}, ${got.length}/${prep.bytes.length} bytes (row NOT updated)`); continue }
    const upd = await db.from("user_shops").update({ logo_url: publicUrl }).eq("id", row.id).like("logo_url", "data:%").select("id")
    if (upd.error || !upd.data?.length) { failed++; console.error(`update skipped ${row.shop_slug}: ${upd.error?.message ?? "row changed meanwhile"}`); continue }
    done++
    if (done % 25 === 0) console.log(`  ...${done} migrated`)
  }

  console.log(`\n${apply ? "migrated" : "would migrate"}: ${done} | skipped: ${skipped} | failed: ${failed}`)
  console.log(`logo bytes: ${kb(origTotal)} -> ${kb(newTotal)} (${origTotal ? Math.round((100 * newTotal) / origTotal) : 0}% of original)`)
  if (skips.length) console.log("skipped detail:\n  " + skips.slice(0, 20).join("\n  "))
  if (backupFile) console.log("backup:", backupFile, "| rollback: npx tsx scripts/migrate-shop-logos.ts --rollback", backupFile)
}

if (require.main === module || process.argv[1]?.endsWith("migrate-shop-logos.ts")) {
  main().catch((e) => { console.error("FAILED:", String(e.message || e).replace(/eyJ[A-Za-z0-9._-]+/g, "[jwt]")); process.exit(1) })
}
