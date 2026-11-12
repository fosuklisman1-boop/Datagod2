/**
 * One-off, owner-approved purge: deletes ALL resolved/rejected legacy complaints (any age) and their
 * evidence photos. pending / in_review complaints and support threads are never touched.
 *
 *   npx tsx scripts/purge-resolved-complaints.ts          dry run (default): counts only, deletes nothing
 *   PURGE_CONFIRM=DELETE-RESOLVED-COMPLAINTS npx tsx scripts/purge-resolved-complaints.ts --apply
 *
 * Env comes from .env.local in the current directory, else from the file named by PURGE_ENV_FILE.
 * Secrets are never taken from argv and never printed. Logs counts only.
 */
import { existsSync } from "fs"
import { join } from "path"
import dotenv from "dotenv"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { deleteOldSupportData } from "../lib/support-cleanup"
import { parsePurgeArgs, PURGE_USAGE } from "../lib/support-purge-cli"

const STATUSES = ["pending", "in_review", "resolved", "rejected"] as const

async function statusCounts(db: SupabaseClient): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const s of STATUSES) {
    const { count, error } = await db.from("complaints").select("id", { count: "exact", head: true }).eq("status", s)
    if (error || count === null) throw new Error(`count failed for status ${s}`)
    out[s] = count
  }
  const { count: total, error } = await db.from("complaints").select("id", { count: "exact", head: true })
  if (error || total === null) throw new Error("count failed for total")
  out.other = total - STATUSES.reduce((n, s) => n + out[s], 0)
  return out
}

async function main(): Promise<number> {
  const parsed = parsePurgeArgs(process.argv.slice(2), process.env)
  if ("error" in parsed) {
    console.error(parsed.error)
    if (!parsed.error.startsWith("usage")) console.error(PURGE_USAGE)
    return 1
  }

  const local = join(process.cwd(), ".env.local")
  const envFile = existsSync(local) ? local : process.env.PURGE_ENV_FILE
  if (envFile && existsSync(envFile)) dotenv.config({ path: envFile })

  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[name]) {
      console.error(`Missing environment variable: ${name}`)
      return 1
    }
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string
  let hostOk = false
  try {
    hostOk = new URL(url).hostname.endsWith(".supabase.co")
  } catch {}
  console.log(`target: Supabase project (host ends with .supabase.co: ${hostOk ? "yes" : "no"})`)

  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } })

  console.log("precheck complaints by status:", await statusCounts(db))

  if (parsed.mode === "dry") {
    const r = await deleteOldSupportData(db, new Date(), { dryRun: true, legacyAnyAge: true })
    console.log({ wouldDeleteComplaints: r.legacyComplaints, wouldRemoveFiles: r.filesRemoved, errors: r.errors ?? 0 })
    console.log("DRY RUN: nothing was deleted. Re-run with --apply to delete.")
    return r.errors ? 2 : 0
  }

  const r = await deleteOldSupportData(db, new Date(), { dryRun: false, legacyAnyAge: true })
  console.log({ deletedComplaints: r.legacyComplaints, removedFiles: r.filesRemoved, errors: r.errors ?? 0 })
  const after = await statusCounts(db)
  console.log("postcheck complaints by status:", after)
  const n = after.resolved + after.rejected
  console.log(`REMAINING resolved+rejected: ${n}`)
  console.log(`pending+in_review: ${after.pending + after.in_review}`)
  return !r.errors && n === 0 ? 0 : 2
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("purge failed:", e instanceof Error ? e.message : "unknown error")
    process.exit(2)
  },
)
