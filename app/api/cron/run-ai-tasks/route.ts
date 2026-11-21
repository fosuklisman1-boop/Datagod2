import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { AIProviderConfig, DEFAULT_CONFIG, resolveProviderForContext } from "@/lib/ai-providers"
import { sendPushToUser } from "@/lib/push-service"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail } from "@/lib/email-service"
import type { AIChatContext } from "@/lib/ai-tools"
import { computeNextRun } from "@/lib/ai-scheduled/next-run"
import { withoutPrepareTools } from "@/lib/ai-scheduled/tools"
import { runStandingOrder } from "@/lib/ai-drafts/standing-order"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return "http://localhost:3000"
}

// ─── System prompts for cron execution ───────────────────────────────────────

function buildCronSystemPrompt(context: AIChatContext, today: string): string {
  const reminderRule = `IMPORTANT: If the prompt starts with "REMINDER ONLY", call the notify_self tool with the reminder text as the message — do NOT call any prepare_* tool or any purchase tool. Call notify_self first, then stop.`

  if (context === "admin") {
    return `You are the Datagod admin AI running a scheduled automated task. Today is ${today} (GMT+0).
Execute the task in the prompt directly and efficiently. Report what you did and the outcome in 1-3 sentences.
ORDER TABLES: orders (dealer wallet), shop_orders (Paystack), ussd_orders, ussd_shop_orders, api_orders.
You cannot change order statuses, wallets, withdrawals, roles or suspensions yourself; scheduled tasks can only report what needs doing.
Do not ask for confirmation — this is automated execution. Act on exactly what the prompt says, using the read and report tools you have.
${reminderRule}`
  }
  return `You are the Datagod AI running a scheduled task for a user. Today is ${today} (GMT+0).
Execute the task in the prompt directly. You cannot place orders yourself; scheduled tasks cannot buy anything on their own.
If the task asks for a purchase, do not attempt it — report that it needs the user's confirmation.
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
    .select("email, phone_number")
    .eq("id", task.user_id)
    .maybeSingle()
  const user = userRow.data

  const title = "DATAGOD AI"
  const statusLine = `${success ? "✓" : "✗"} ${task.name}`
  const body = `${statusLine}: ${resultText.slice(0, 180) || (success ? "Task completed." : "Task failed.")}`
  // Push always sent; SMS always added on failures
  const channels = [...new Set([...(task.notify_channels ?? ["push"]), "push", ...(success ? [] : ["sms"])])]

  if (channels.includes("push")) {
    try { await sendPushToUser(task.user_id, { title, body }) } catch {}
  }

  if (channels.includes("sms") && user?.phone_number) {
    try {
      await sendSMS({
        phone: user.phone_number,
        message: `${title} — ${body}`.slice(0, 160),
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
        subject: `DATAGOD AI — ${statusLine}`,
        htmlContent: `<p>${resultText.replace(/\n/g, "<br>")}</p>`,
        textContent: resultText,
        type: "scheduled_task_result",
        userId: task.user_id,
        skipLogging: true,
      })
    } catch {}
  }
}

// ─── Standing orders (no model) ───────────────────────────────────────────────

const MAX_CONSECUTIVE_SKIPS = 3

const SKIP_TEXT: Record<string, string> = {
  above_cap: "the price is now above the limit you approved",
  package_unavailable: "the package is not available right now",
  insufficient_balance: "your wallet balance is too low",
  prices_unavailable: "prices could not be loaded",
  check_unavailable: "a safety check could not be completed",
}

async function notifyPushOnly(userId: string, body: string) {
  try { await sendPushToUser(userId, { title: "DATAGOD AI", body: body.slice(0, 180) }) } catch {}
}

async function processStandingOrder(
  task: {
    id: string
    name: string
    user_id: string
    schedule_type: string
    run_at_time?: string | null
    run_on_days?: number[] | null
    run_at_timestamp?: string | null
    notify_channels: string[]
    next_run_at: string
    approved_draft_id: string | null
    standing_order: Record<string, unknown> | null
    consecutive_skips?: number | null
  },
  cronSecret: string,
  baseUrl: string
) {
  let outcome: Awaited<ReturnType<typeof runStandingOrder>>
  try {
    outcome = await runStandingOrder(supabase, task as Parameters<typeof runStandingOrder>[1], { baseUrl, cronSecret })
  } catch {
    // One attempt only: a thrown error is reported like a failed purchase and never retried in this run.
    outcome = { result: "failed", reason: "error" }
  }

  const advance: Record<string, unknown> = { next_run_at: computeNextRun(task, { includeToday: false }).toISOString() }
  if (task.schedule_type === "once") advance.is_active = false

  if (outcome.result === "ordered") {
    const text = outcome.orderCode ? `Order placed. Code ${outcome.orderCode}.` : "Order placed."
    await supabase.from("ai_scheduled_tasks").update({ ...advance, consecutive_skips: 0, last_result: text, last_success: true }).eq("id", task.id)
    await notifyTaskResult(task, text, true)
    return
  }

  if (outcome.result === "skipped") {
    const skips = (task.consecutive_skips ?? 0) + 1
    const pausing = skips >= MAX_CONSECUTIVE_SKIPS
    const why = SKIP_TEXT[outcome.reason] ?? "it could not run"
    const text = pausing
      ? `Skipped (${why}). Paused after ${MAX_CONSECUTIVE_SKIPS} skipped runs in a row.`
      : `Skipped this time: ${why}. No order was placed.`
    await supabase
      .from("ai_scheduled_tasks")
      .update({ ...advance, consecutive_skips: skips, last_result: text, ...(pausing ? { is_active: false } : {}) })
      .eq("id", task.id)
    // Info push only: a skip is not a failure, so no SMS.
    await notifyPushOnly(task.user_id, `${task.name}: ${text}`)
    return
  }

  if (outcome.result === "paused") {
    const text =
      outcome.reason === "no_buy_right"
        ? "Your scheduled order was paused: your account can no longer buy data."
        : outcome.reason === "phone_unverified"
          ? "Your scheduled order was paused: please verify your phone number."
          : "Your scheduled order was paused for a safety check"
    await supabase.from("ai_scheduled_tasks").update({ is_active: false, last_result: text, last_success: false }).eq("id", task.id)
    await notifyPushOnly(task.user_id, `${task.name}: ${text}.`)
    return
  }

  // Purchase failed (non-2xx other than 402, or no answer): the existing failure path, which adds SMS.
  const text = `Task failed: the order could not be placed (${outcome.reason}).`
  await supabase.from("ai_scheduled_tasks").update({ ...advance, last_result: text, last_success: false }).eq("id", task.id)
  await notifyTaskResult(task, text, false)
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
      .select("id, name, prompt, context, user_id, user_role, schedule_type, run_at_time, run_on_days, run_at_timestamp, notify_channels, next_run_at, standing_order, approved_draft_id, consecutive_skips")
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

      // A standing order runs WITHOUT the model: it can only ever do the one purchase the user approved.
      if (task.standing_order) {
        try {
          await processStandingOrder(task as Parameters<typeof processStandingOrder>[0], cronSecret, baseUrl)
        } catch {
          console.error("[CRON-AI-TASKS] standing order run errored")
        }
        processed++
        continue
      }

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
          // Nobody is present to tap a confirm card, so a dashboard run never gets a prepare_* tool.
          // (Admin runs are handled separately; the helper is reusable for them.)
          ...(effectiveContext === "dashboard" ? { toolFilter: withoutPrepareTools } : {}),
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
      const nextRunAt = computeNextRun(task, { includeToday: false })

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
