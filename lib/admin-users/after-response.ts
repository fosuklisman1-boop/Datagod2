// Run work after the response is sent (Next.js after()), still inside the function's maxDuration. Used by the
// bulk route so 200 users' SMS / email do not hold the request open. Outside a request scope (scripts) the task
// just runs in the background.
import { after } from "next/server"

export function runAfterResponse(task: () => Promise<void>): void {
  const safe = () => task().catch((e) => console.error("[AFTER-RESPONSE] task failed:", e?.message ?? e))
  try {
    after(safe)
  } catch {
    void safe()
  }
}
