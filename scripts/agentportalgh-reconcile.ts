// READ-ONLY reconcile: re-check stuck AgentPortalGH orders against AGP's live API.
//
//   npx tsx scripts/agentportalgh-reconcile.ts <input.json> <output.json>
//
// Input:  [{ tracking_id, mtn_order_id, recipient_phone, size_gb, created_at }]
// Output: [{ tracking_id, mtn_order_id, outcome, external_status, failed_reason }]
// Needs AGENTPORTALGH_API_KEY in the environment (never printed). Never writes to any database.
import { readFileSync, writeFileSync } from "fs"

type Row = { tracking_id: string; mtn_order_id: string; recipient_phone: string; size_gb: number | string; created_at: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const [inPath, outPath] = process.argv.slice(2)
  if (!inPath || !outPath) {
    console.error("Usage: npx tsx scripts/agentportalgh-reconcile.ts <input.json> <output.json>")
    process.exit(1)
  }
  if (!process.env.AGENTPORTALGH_API_KEY) {
    console.error("AGENTPORTALGH_API_KEY is not set")
    process.exit(1)
  }
  // lib/supabase.ts builds its clients at import time and throws without these. They are never
  // used here (resolveStatusFromAgp does not touch Supabase) — placeholders only, no DB access.
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:1"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "placeholder-anon-key"
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "placeholder-service-role-key"
  // Imported lazily so the env check above runs first. The provider module pulls in the Supabase
  // client factory, but resolveStatusFromAgp itself never touches it.
  const { resolveStatusFromAgp } = await import("../lib/mtn-providers/agentportalgh-provider")

  const rows: Row[] = JSON.parse(readFileSync(inPath, "utf8"))
  const out: Array<{ tracking_id: string; mtn_order_id: string; outcome: "completed" | "failed" | "processing"; external_status: string | null; failed_reason: string | null }> = []
  const counts = { completed: 0, failed: 0, processing: 0 }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    let outcome: "completed" | "failed" | "processing" = "processing"
    let external: string | null = null
    let reason: string | null = null
    try {
      const res = await resolveStatusFromAgp(
        r.mtn_order_id,
        r.recipient_phone,
        r.size_gb !== null && r.size_gb !== undefined ? Number(r.size_gb) : undefined,
        r.created_at ? String(r.created_at).slice(0, 10) : undefined,
        // Conservative: the SQL export can't tell us about same-day siblings here, so never use the
        // phone+size guess — only exact reference matches count.
        { hasAmbiguousSibling: true }
      )
      if (res.success && (res.status === "completed" || res.status === "failed")) {
        outcome = res.status
        external = res.order?.status ?? null
        reason = res.status === "failed" ? (res.message ?? null) : null
      }
    } catch (err) {
      console.warn(`row ${i + 1}: lookup error`, err instanceof Error ? err.message : err)
    }
    counts[outcome]++
    out.push({ tracking_id: r.tracking_id, mtn_order_id: r.mtn_order_id, outcome, external_status: external, failed_reason: reason })
    if (i < rows.length - 1) await sleep(300)
  }

  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`Checked ${rows.length}: completed=${counts.completed} failed=${counts.failed} processing=${counts.processing}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
