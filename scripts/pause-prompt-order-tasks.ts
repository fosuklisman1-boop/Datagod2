// One-off deploy script: pause legacy dashboard scheduled AI tasks that order data through a typed
// prompt (they stop working once the cron AI loses ordering tools) and tell each owner to re-approve.
//
//   npx tsx scripts/pause-prompt-order-tasks.ts            # dry run (default): prints a table, changes nothing
//   npx tsx scripts/pause-prompt-order-tasks.ts --apply    # pauses the tasks and sends one push per owner
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (never printed).
// Idempotent: paused tasks are inactive, so a re-run finds nothing new.
// Tasks that already have a standing_order are new-style and never touched.
import { createClient } from "@supabase/supabase-js"
import { maskPrompt, PauseChunkError, runPause, selectPromptOrderTasks, type PauseTask } from "../lib/ai-drafts/pause-prompt-orders"

const PAGE = 1000

async function main() {
  const apply = process.argv.includes("--apply")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    process.exit(1)
  }
  const supabase = createClient(url, key)

  const rows: PauseTask[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("ai_scheduled_tasks")
      .select("id, user_id, schedule_type, prompt, is_active, context, standing_order")
      .eq("is_active", true)
      .eq("context", "dashboard")
      .is("standing_order", null)
      .order("id")
      .range(from, from + PAGE - 1)
    if (error) {
      console.error("Query failed:", error.message)
      process.exit(1)
    }
    rows.push(...((data ?? []) as PauseTask[]))
    if (!data || data.length < PAGE) break
  }

  const tasks = selectPromptOrderTasks(rows)
  console.log(apply ? "MODE: APPLY" : "MODE: DRY RUN (pass --apply to pause and notify)")
  console.log("task_id\tuser_id\tschedule_type\tprompt")
  for (const t of tasks) console.log(`${t.id}\t${t.user_id}\t${t.schedule_type}\t${maskPrompt(t.prompt)}`)

  // Imported lazily and only for --apply: lib/push-service builds its Supabase client at import time.
  const sendPushToUser = apply ? (await import("../lib/push-service")).sendPushToUser : null
  let result
  try {
    result = await runPause(tasks, apply, {
      async deactivate(ids) {
        const { error } = await supabase.from("ai_scheduled_tasks").update({ is_active: false }).in("id", ids)
        if (error) throw new Error(error.message)
      },
      push: (userId, payload) => sendPushToUser!(userId, payload),
    })
  } catch (err) {
    if (err instanceof PauseChunkError) {
      console.error(err.message)
      console.error(`Paused so far (${err.pausedIds.length}): ${err.pausedIds.join(",")}`)
      console.error(`Failing chunk, state unknown (${err.failedIds.length}): ${err.failedIds.join(",")}`)
      console.error(`Notified: ${err.result.notified}, push failures: ${err.result.pushFailures}`)
      process.exit(1)
    }
    throw err
  }

  console.log(`Total matched: ${result.matched}`)
  if (apply) console.log(`Paused: ${result.paused}, notified: ${result.notified}, push failures: ${result.pushFailures}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : "failed")
  process.exit(1)
})
