import type { SupabaseClient } from "@supabase/supabase-js"
import { removeAttachments } from "@/lib/support-attachment"

export const SUPPORT_RETENTION_DAYS = 90

const BATCH = 200
const MESSAGE_PAGE = 1000
const DAY_MS = 86_400_000

export interface SupportCleanupResult {
  closedThreads: number
  legacyComplaints: number
  filesRemoved: number
  /** Number of failed steps (a select or delete that errored). Zero on a clean run. */
  errors?: number
}

/** Every attachment path of the given threads' messages, or null when a read failed. */
async function threadFilePaths(db: SupabaseClient, threadIds: string[]): Promise<string[] | null> {
  const paths: string[] = []
  let last = ""
  for (;;) {
    let q = db.from("support_messages").select("id, attachment_path").in("thread_id", threadIds).not("attachment_path", "is", null)
    if (last) q = q.gt("id", last)
    const { data, error } = await q.order("id", { ascending: true }).limit(MESSAGE_PAGE)
    if (error) return null
    const rows = (data ?? []) as { id: string; attachment_path: string | null }[]
    for (const r of rows) if (r.attachment_path) paths.push(r.attachment_path)
    if (rows.length < MESSAGE_PAGE) return paths
    last = rows[rows.length - 1].id
  }
}

function evidencePaths(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return []
  const e = evidence as Record<string, unknown>
  return ["balance_image_path", "momo_receipt_path"].flatMap((k) => (typeof e[k] === "string" && e[k] !== "" ? [e[k] as string] : []))
}

type Page = { ids: string[]; files: string[] }

/**
 * Walks one table in id order, 200 rows at a time. For each page: collect files, remove them, then
 * delete the rows. Keyset paging (id > last) keeps a dry run, and a failed delete, from re-reading
 * the same rows; a failure ends that table's loop.
 */
async function sweep(
  db: SupabaseClient,
  dryRun: boolean,
  fetchPage: (after: string) => Promise<Page | null>,
  table: "support_threads" | "complaints",
  /** Delete by id, repeating the selection predicates so a row that changed since the select survives. */
  deleteGuarded: (ids: string[]) => PromiseLike<{ data: { id: string }[] | null; error: unknown }>,
): Promise<{ rows: number; files: number; errors: number }> {
  let rows = 0
  let files = 0
  let errors = 0
  let after = ""
  for (;;) {
    const page = await fetchPage(after)
    if (!page) {
      errors++
      break
    }
    if (page.ids.length === 0) break
    after = page.ids[page.ids.length - 1]
    if (!dryRun) {
      // Files go first; a failed removal never blocks the row delete (the helper never throws).
      if (page.files.length > 0) await removeAttachments(db, page.files)
      const { data, error } = await deleteGuarded(page.ids)
      if (error) {
        console.error("[SUPPORT-CLEANUP] delete failed", { table, batch: page.ids.length })
        errors++
        break
      }
      // Count what was actually deleted; rows that changed meanwhile were skipped by the guard.
      rows += (data ?? []).length
    } else {
      rows += page.ids.length
    }
    files += page.files.length
    if (page.ids.length < BATCH) break
  }
  return { rows, files, errors }
}

/** Delete closed threads and resolved/rejected legacy complaints older than the retention window. */
export async function deleteOldSupportData(
  db: SupabaseClient,
  now: Date,
  opts: { dryRun?: boolean } = {},
): Promise<SupportCleanupResult> {
  const dryRun = opts.dryRun === true
  const cutoff = new Date(now.getTime() - SUPPORT_RETENTION_DAYS * DAY_MS).toISOString()

  const threads = await sweep(
    db,
    dryRun,
    async (after) => {
      let q = db.from("support_threads").select("id").eq("status", "closed").lt("closed_at", cutoff)
      if (after) q = q.gt("id", after)
      const { data, error } = await q.order("id", { ascending: true }).limit(BATCH)
      if (error) return null
      const ids = ((data ?? []) as { id: string }[]).map((r) => r.id)
      if (ids.length === 0) return { ids, files: [] }
      const files = await threadFilePaths(db, ids)
      // Without the file list, deleting would orphan the screenshots: leave the batch for the next run.
      return files ? { ids, files } : null
    },
    "support_threads",
    (ids) => db.from("support_threads").delete().in("id", ids).eq("status", "closed").lt("closed_at", cutoff).select("id"),
  )

  const complaints = await sweep(
    db,
    dryRun,
    async (after) => {
      let q = db.from("complaints").select("id, evidence").in("status", ["resolved", "rejected"]).lt("updated_at", cutoff)
      if (after) q = q.gt("id", after)
      const { data, error } = await q.order("id", { ascending: true }).limit(BATCH)
      if (error) return null
      const rows = (data ?? []) as { id: string; evidence: unknown }[]
      return { ids: rows.map((r) => r.id), files: rows.flatMap((r) => evidencePaths(r.evidence)) }
    },
    "complaints",
    (ids) => db.from("complaints").delete().in("id", ids).in("status", ["resolved", "rejected"]).lt("updated_at", cutoff).select("id"),
  )

  return {
    closedThreads: threads.rows,
    legacyComplaints: complaints.rows,
    filesRemoved: threads.files + complaints.files,
    errors: threads.errors + complaints.errors,
  }
}
