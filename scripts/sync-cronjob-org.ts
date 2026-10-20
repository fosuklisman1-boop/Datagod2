/**
 * Syncs the crons in vercel.json to cron-job.org.
 *
 *   npx tsx scripts/sync-cronjob-org.ts                 dry run, ZERO API calls (assumes an empty account)
 *   npx tsx scripts/sync-cronjob-org.ts --plan          1 API call: real diff against the account
 *   npx tsx scripts/sync-cronjob-org.ts --apply         create/adopt jobs (created DISABLED; adopted jobs keep their enabled state)
 *   npx tsx scripts/sync-cronjob-org.ts --enable A      enable every owned job in batch A (or B / C)
 *   npx tsx scripts/sync-cronjob-org.ts --disable A     disable them again (rollback)
 *   add  --only /api/cron/some-route   to act on a single route
 *
 * Secrets come from .env.local (CRONJOB_API_KEY, CRON_SECRET) - never from argv, never printed.
 * Daily API budget (100/day on cron-job.org) is tracked in .cron-sync-budget.json; we stop at 80.
 */
import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import dotenv from "dotenv"
import { buildJobSpecs, toCreatePayload, redactSecret, TITLE_PREFIX, type Batch, type JobSpec } from "../lib/cron-migration/jobs"
import { planActions, checkBudget, type BudgetState } from "../lib/cron-migration/plan"
import { createClient } from "../lib/cron-migration/cronjob-api"

const ROOT = process.cwd()
const HOST = process.env.CRON_HOST || "https://www.datagod.store"
const BUDGET_FILE = join(ROOT, ".cron-sync-budget.json")

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1] ?? ""
}
const has = (name: string) => process.argv.includes(name)

function readBudget(): BudgetState | null {
  try {
    return existsSync(BUDGET_FILE) ? JSON.parse(readFileSync(BUDGET_FILE, "utf8")) : null
  } catch {
    return null
  }
}

function reserve(needed: number) {
  const today = new Date().toISOString().slice(0, 10)
  const r = checkBudget(readBudget(), today, needed)
  if (!r.ok) {
    throw new Error(`Daily cron-job.org API budget would be exceeded (used ${r.state.used}, need ${needed}, cap 80). Try again tomorrow.`)
  }
  writeFileSync(BUDGET_FILE, JSON.stringify(r.state))
}

/** The cron routes must answer 401 (not a redirect) to an unauthenticated GET, or the Authorization header would be lost/ignored. */
async function preflight() {
  const probe = `${HOST}/api/cron/sms-kyc-purge`
  const res = await fetch(probe, { redirect: "manual" })
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Preflight: ${probe} redirects (${res.status} -> ${res.headers.get("location")}). A redirect can drop the Authorization header. Fix CRON_HOST first.`)
  }
  if (res.status !== 401) {
    throw new Error(`Preflight: expected 401 from ${probe} without credentials, got ${res.status}. Aborting.`)
  }
}

function printTable(rows: { spec: JobSpec; action: string }[]) {
  for (const { spec, action } of rows) {
    console.log(`${action.padEnd(8)} ${spec.batch} ${spec.fulfillment ? "$" : " "} ${spec.cron.padEnd(12)} ${spec.path}`)
  }
  console.log(`\n${rows.length} jobs ($ = fulfillment class, failure-alerted)`)
}

async function main() {
  dotenv.config({ path: join(ROOT, ".env.local") })
  const apiKey = process.env.CRONJOB_API_KEY || ""
  const cronSecret = process.env.CRON_SECRET || ""

  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"))
  let specs = buildJobSpecs(vercel.crons, HOST)
  const only = arg("--only")
  if (only) specs = specs.filter((s) => s.path === only)
  if (specs.length === 0) throw new Error("No matching crons")

  const enableBatch = arg("--enable") as Batch | undefined
  const disableBatch = arg("--disable") as Batch | undefined
  const live = has("--plan") || has("--apply") || enableBatch || disableBatch

  if (!live) {
    console.log("DRY RUN - no API calls (assuming an empty account). Use --plan for the real diff.\n")
    printTable(specs.map((spec) => ({ spec, action: "create" })))
    return
  }

  if (!apiKey) throw new Error("CRONJOB_API_KEY missing in .env.local")
  const client = createClient(apiKey)

  if (has("--plan") || has("--apply")) {
    if (has("--apply")) {
      if (!cronSecret) throw new Error("CRON_SECRET missing in .env.local")
      await preflight()
    }
    reserve(1)
    const existing = await client.listJobs()
    const actions = planActions(specs, existing, HOST)
    printTable(actions.map((a) => ({ spec: a.spec, action: a.kind })))
    if (!has("--apply")) return

    const writes = actions.filter((a) => a.kind !== "skip")
    reserve(writes.length)
    for (const a of writes) {
      const payload = toCreatePayload(a.spec, cronSecret) as { job: Record<string, unknown> }
      if (a.kind === "create") {
        const id = await client.createJob(payload)
        console.log(`created ${id} ${a.spec.path}`)
      } else {
        delete payload.job.enabled // adopted jobs keep whatever enabled state they have
        await client.updateJob(a.jobId!, payload)
        console.log(`updated ${a.jobId} ${a.spec.path}`)
      }
    }
    return
  }

  // --enable / --disable <batch>
  const batch = (enableBatch || disableBatch) as Batch
  if (!["A", "B", "C"].includes(batch)) throw new Error("Batch must be A, B or C")
  const want = !!enableBatch
  reserve(1)
  const existing = await client.listJobs()
  const todo = specs
    .filter((s) => s.batch === batch)
    .map((s) => ({ spec: s, job: existing.find((e) => e.url === s.url && e.title.startsWith(TITLE_PREFIX)) }))
  const missing = todo.filter((t) => !t.job)
  if (missing.length) throw new Error(`Not created yet (run --apply first): ${missing.map((m) => m.spec.path).join(", ")}`)
  const changes = todo.filter((t) => t.job!.enabled !== want)
  reserve(changes.length)
  for (const t of changes) {
    await client.updateJob(t.job!.jobId, { job: { enabled: want } })
    console.log(`${want ? "enabled" : "disabled"} ${t.job!.jobId} ${t.spec.path}`)
  }
  console.log(`${changes.length} changed, ${todo.length - changes.length} already ${want ? "enabled" : "disabled"}`)
}

main().catch((e) => {
  const secret = process.env.CRON_SECRET || ""
  const key = process.env.CRONJOB_API_KEY || ""
  console.error(redactSecret(redactSecret(String(e.message || e), secret), key))
  process.exit(1)
})
