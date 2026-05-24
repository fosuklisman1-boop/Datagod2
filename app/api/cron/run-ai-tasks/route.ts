import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { AIProviderConfig, DEFAULT_CONFIG, resolveProviderForContext } from "@/lib/ai-providers"
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
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return "http://localhost:3000"
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
  const reminderRule = `IMPORTANT: If the prompt starts with "REMINDER ONLY" or says "do not place any order", send a notification with the reminder message and stop — do NOT call place_wallet_order or any purchase tool under any circumstances.`

  if (context === "admin") {
    return `You are the Datagod admin AI running a scheduled automated task. Today is ${today} (GMT+0).
Execute the task in the prompt directly and efficiently. Report what you did and the outcome in 1-3 sentences.
ORDER TABLES: orders (dealer wallet), shop_orders (Paystack), ussd_orders, ussd_shop_orders, api_orders.
For bulk status updates use bulk_update_order_status. For withdrawals use manage_withdrawal with withdrawal_ids array.
Do not ask for confirmation — this is automated execution. Act on exactly what the prompt says.
${reminderRule}`
  }
  return `You are the Datagod AI running a scheduled task for a user. Today is ${today} (GMT+0).
Execute the task in the prompt directly. Always call get_wallet_balance before placing any order.
If the wallet balance is insufficient, do not place the order — report the shortfall in your response.
Report what happened in 1-2 sentences. Do not ask for confirmation — this is automated execution.
${reminderRule}`
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
  // Always include SMS on failures so the user is notified even if push is missed
  const channels = success
    ? (task.notify_channels ?? ["push"])
    : [...new Set([...(task.notify_channels ?? ["push"]), "sms"])]

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

// ─── Load AI config from DB (same as chat route) ─────────────────────────────

async function loadAIConfig(): Promise<AIProviderConfig> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "ai_provider_config")
      .maybeSingle()
    return (data?.value as AIProviderConfig) ?? DEFAULT_CONFIG
  } catch {
    return DEFAULT_CONFIG
  }
}

// ─── Sanitize error message for user-facing notifications ─────────────────────

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes("authentication_error") || raw.includes("x-api-key") || raw.includes("API key")) {
    return "AI service authentication failed — check the API key in admin settings."
  }
  if (raw.includes("insufficient_quota") || raw.includes("RESOURCE_EXHAUSTED") || raw.includes("quota")) {
    return "AI service quota exceeded. The task will retry next time."
  }
  if (raw.includes("rate_limit") || raw.includes("429")) {
    return "AI service rate limit hit. The task will retry next time."
  }
  if (raw.includes("<!DOCTYPE") || raw.includes("not valid JSON")) {
    return "Internal routing error. Contact support if this persists."
  }
  // Strip raw JSON blobs from provider error responses
  // Strip raw JSON blobs — remove everything from first { to end
  const stripped = raw.indexOf("{") !== -1 ? raw.slice(0, raw.indexOf("{")).trim() : raw.trim()
  return stripped.slice(0, 200) || "Unexpected error. Check logs for details."
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

    // Load AI config from DB — same as the chat route, so custom keys/providers are respected
    const aiConfig = await loadAIConfig()
    const today = new Date().toISOString().split("T")[0]
    const cronSecret = process.env.CRON_SECRET!
    const baseUrl = getBaseUrl()

    let processed = 0

    for (const task of tasks) {
      const runAt = new Date().toISOString()

      // Optimistically stamp last_run_at to prevent double-execution on slow tasks
      await supabase
        .from("ai_scheduled_tasks")
        .update({ last_run_at: runAt })
        .eq("id", task.id)

      let resultText = ""
      let success = false

      try {
        // Re-verify the user's actual role from the DB — never trust the stored user_role.
        // A user who bypassed the API could have set user_role='admin' in the task row.
        let effectiveRole = "user"
        let effectiveContext: AIChatContext = "dashboard"

        if (task.user_id) {
          const { data: userRow } = await supabase
            .from("users")
            .select("role")
            .eq("id", task.user_id)
            .maybeSingle()
          effectiveRole = userRow?.role ?? "user"
        }

        // Only allow admin context if the user actually has the admin role in the DB
        if (effectiveRole === "admin" && task.context === "admin") {
          effectiveContext = "admin"
        }

        const systemPrompt = buildCronSystemPrompt(effectiveContext, today)
        const { provider, model } = resolveProviderForContext(effectiveContext, aiConfig)

        const result = await runAgenticLoop({
          provider,
          model,
          system: systemPrompt,
          context: effectiveContext,
          messages: [{ role: "user", content: task.prompt }],
          toolCtx: {
            userId: task.user_id ?? undefined,
            jwtToken: cronSecret,
            userRole: effectiveRole,
            baseUrl,
          },
          maxIterations: 8,
          // No onEvent — silent execution
        })

        resultText = result.text || "Task completed (no text output)."
        success = true
      } catch (err) {
        resultText = `Task failed: ${friendlyError(err)}`
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
