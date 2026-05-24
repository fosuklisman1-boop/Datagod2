import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { DEFAULT_CONFIG, resolveProviderForContext } from "@/lib/ai-providers"
import { sendPushToUser } from "@/lib/push-service"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail } from "@/lib/email-service"
import type { AIChatContext } from "@/lib/ai-tools"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
  return process.env.NODE_ENV === "production" ? "" : "http://localhost:3000"
}

// ─── computeNextRun ───────────────────────────────────────────────────────────

function computeNextRun(task: {
  schedule_type: string
  run_at_time?: string | null
  run_on_days?: number[] | null
  run_at_timestamp?: string | null
}): Date {
  const now = new Date()

  if (task.schedule_type === "once") {
    return task.run_at_timestamp ? new Date(task.run_at_timestamp) : now
  }

  if (task.schedule_type === "hourly") {
    const next = new Date(now)
    next.setUTCMinutes(0, 0, 0)
    next.setUTCHours(next.getUTCHours() + 1)
    return next
  }

  if (task.schedule_type === "daily" && task.run_at_time) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    const candidate = new Date(now)
    candidate.setUTCHours(hh, mm, 0, 0)
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1)
    return candidate
  }

  if (task.schedule_type === "weekly" && task.run_at_time && task.run_on_days?.length) {
    const [hh, mm] = task.run_at_time.split(":").map(Number)
    for (let offset = 1; offset <= 7; offset++) {
      const candidate = new Date(now)
      candidate.setUTCDate(candidate.getUTCDate() + offset)
      candidate.setUTCHours(hh, mm, 0, 0)
      if (task.run_on_days.includes(candidate.getUTCDay())) return candidate
    }
  }

  return new Date(now.getTime() + 60 * 60 * 1000)
}

// ─── System prompts for cron execution ───────────────────────────────────────

function buildCronSystemPrompt(context: AIChatContext, today: string): string {
  if (context === "admin") {
    return `You are the Datagod admin AI running a scheduled automated task. Today is ${today} (GMT+0).
Execute the task in the prompt directly and efficiently. Report what you did and the outcome in 1-3 sentences.
ORDER TABLES: orders (dealer wallet), shop_orders (Paystack), ussd_orders, ussd_shop_orders, api_orders.
For bulk status updates use bulk_update_order_status. For withdrawals use manage_withdrawal with withdrawal_ids array.
Do not ask for confirmation — this is automated execution. Act on exactly what the prompt says.`
  }
  return `You are the Datagod AI running a scheduled task for a user. Today is ${today} (GMT+0).
Execute the task in the prompt directly. Always call get_wallet_balance before placing any order.
If the wallet balance is insufficient, do not place the order — report the shortfall in your response.
Report what happened in 1-2 sentences. Do not ask for confirmation — this is automated execution.`
}

// ─── Notify after task run ────────────────────────────────────────────────────

async function notifyTaskResult(
  task: { name: string; user_id: string; notify_channels: string[] },
  resultText: string,
  success: boolean
) {
  const userRow = await supabase
    .from("users")
    .select("email, phone")
    .eq("id", task.user_id)
    .maybeSingle()
  const user = userRow.data

  const title = `${success ? "✓" : "✗"} ${task.name}`
  const body = resultText.slice(0, 200) || (success ? "Task completed." : "Task failed.")
  const channels = task.notify_channels ?? ["push"]

  if (channels.includes("push")) {
    try { await sendPushToUser(task.user_id, { title, body }) } catch {}
  }

  if (channels.includes("sms") && user?.phone) {
    try {
      await sendSMS({
        phone: user.phone,
        message: `${title}: ${body}`.slice(0, 160),
        type: "scheduled_task_result",
        userId: task.user_id,
        skipLogging: true,
      })
    } catch {}
  }

  if (channels.includes("email") && user?.email) {
    try {
      await sendEmail({
        to: [{ email: user.email }],
        subject: title,
        htmlContent: `<p>${resultText.replace(/\n/g, "<br>")}</p>`,
        textContent: resultText,
        type: "scheduled_task_result",
        userId: task.user_id,
        skipLogging: true,
      })
    } catch {}
  }
}

// ─── GET: process due tasks ───────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const now = new Date().toISOString()

    // Fetch all due tasks in one query
    const { data: tasks, error: fetchError } = await supabase
      .from("ai_scheduled_tasks")
      .select("id, name, prompt, context, user_id, user_role, schedule_type, run_at_time, run_on_days, run_at_timestamp, notify_channels")
      .lte("next_run_at", now)
      .eq("is_active", true)

    if (fetchError) {
      console.error("[CRON-AI-TASKS] Failed to fetch tasks:", fetchError)
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!tasks?.length) {
      return NextResponse.json({ processed: 0 })
    }

    const { provider, model } = resolveProviderForContext("admin", DEFAULT_CONFIG)
    const today = new Date().toISOString().split("T")[0]
    const cronSecret = process.env.CRON_SECRET!
    const baseUrl = getBaseUrl()

    let processed = 0

    for (const task of tasks) {
      const taskContext = (task.context ?? "admin") as AIChatContext
      const runAt = new Date().toISOString()

      // Optimistically stamp last_run_at to prevent double-execution on slow tasks
      await supabase
        .from("ai_scheduled_tasks")
        .update({ last_run_at: runAt })
        .eq("id", task.id)

      let resultText = ""
      let success = false

      try {
        const systemPrompt = buildCronSystemPrompt(taskContext, today)

        const result = await runAgenticLoop({
          provider,
          model,
          system: systemPrompt,
          context: taskContext,
          messages: [{ role: "user", content: task.prompt }],
          toolCtx: {
            userId: task.user_id ?? undefined,
            jwtToken: cronSecret,
            userRole: task.user_role ?? "user",
            baseUrl,
          },
          maxIterations: 8,
          // No onEvent — silent execution
        })

        resultText = result.text || "Task completed (no text output)."
        success = true
      } catch (err) {
        resultText = `Task failed: ${err instanceof Error ? err.message : String(err)}`
        success = false
        console.error(`[CRON-AI-TASKS] Task ${task.id} (${task.name}) failed:`, err)
      }

      // Compute next run time
      const nextRunAt = computeNextRun(task)

      // Update task record
      const updatePayload: Record<string, unknown> = {
        last_result: resultText.slice(0, 2000),
        last_success: success,
        next_run_at: nextRunAt.toISOString(),
      }
      if (task.schedule_type === "once") {
        updatePayload.is_active = false
      }

      await supabase
        .from("ai_scheduled_tasks")
        .update(updatePayload)
        .eq("id", task.id)

      // Notify task owner
      if (task.user_id) {
        await notifyTaskResult(task, resultText, success)
      }

      processed++
    }

    return NextResponse.json({ processed })
  } catch (err) {
    console.error("[CRON-AI-TASKS] Unexpected error:", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
