import type { SupabaseClient } from "@supabase/supabase-js"
import { createDraft } from "./repo"
import { CAPS, EXPIRY_MS, type DraftToolResult } from "./types"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { walletOrderPrice } from "@/lib/pricing/wallet-order-price"

export interface PrepareWalletOrderCtx {
  userId: string
  userRole: string
  conversationKey: string | null
}

export interface PrepareWalletOrderInput {
  network: string
  size: string
  phone_number: string
  schedule?: {
    type: string
    runAtTime?: string
    runOnDays?: number[]
    runAtTimestamp?: string
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const DUPLICATE_WINDOW_MS = 10 * 60_000

const refuse = (code: string, message: string): DraftToolResult => ({ refused: true, code, message })
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

function normalisePhone(raw: string): string {
  const s = String(raw ?? "").replace(/[\s\-()]/g, "")
  if (s.startsWith("+233")) return "0" + s.slice(4)
  if (s.startsWith("233") && s.length === 12) return "0" + s.slice(3)
  return s
}

/** 024 *** 4567: first 3 and last 4 digits. */
function maskPhone(local: string): string {
  return `${local.slice(0, 3)} *** ${local.slice(-4)}`
}

function describeSchedule(s: NonNullable<PrepareWalletOrderInput["schedule"]>, price: number): string {
  const cap = `up to GHS ${price.toFixed(2)} each time`
  const time = s.runAtTime ? ` ${s.runAtTime}` : ""
  if (s.type === "once") return `Once${s.runAtTimestamp ? ` at ${s.runAtTimestamp}` : ""} — ${cap}`
  if (s.type === "daily") return `Every day${time} — ${cap}`
  const days = (s.runOnDays ?? []).map((d) => DAY_NAMES[d]).filter(Boolean)
  return `Every ${days.length ? days.join(", ") : "week"}${time} — ${cap}`
}

/**
 * Builds a confirm-card draft for a wallet data order. Re-derives package, price and balance from the DB, refuses
 * what cannot be drafted, and stores a pending draft. Writes no order and moves no money.
 */
export async function prepareWalletOrder(
  db: SupabaseClient,
  ctx: PrepareWalletOrderCtx,
  input: PrepareWalletOrderInput,
): Promise<DraftToolResult> {
  const schedule = input.schedule
  if (schedule && !["once", "daily", "weekly"].includes(schedule.type)) {
    return refuse("hourly_not_allowed", "Hourly or other repeating schedules are not allowed. Offer a once, daily or weekly schedule instead.")
  }

  const phone = normalisePhone(input.phone_number)
  if (!/^0\d{9}$/.test(phone)) {
    return refuse("invalid_phone", "Ask for a valid Ghana number to receive the data, e.g. 0244123456.")
  }

  const { data: pkg, error: pkgErr } = await db
    .from("packages")
    .select("id, size, price, dealer_price, is_available")
    .ilike("network", String(input.network))
    .eq("size", String(input.size))
    .eq("is_available", true)
    .maybeSingle()
  if (pkgErr || !pkg) {
    return refuse("unknown_package", `Package not found: ${input.network} ${input.size}. Check the available packages and ask the user to pick one.`)
  }

  const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
  if (prefixCheckEnabled) {
    const check = validateNetworkPrefix(String(input.network), phone, prefixMap)
    if (!check.ok) return refuse("prefix_mismatch", check.message)
  }

  let price: number
  try {
    price = round2(await walletOrderPrice(db, ctx.userId, ctx.userRole, pkg as any))
  } catch {
    return refuse("prices_unavailable", "Prices could not be loaded right now. Ask the user to try again shortly.")
  }
  if (!Number.isFinite(price) || price <= 0) {
    return refuse("prices_unavailable", "Prices could not be loaded right now. Ask the user to try again shortly.")
  }

  if (price > CAPS.walletOrderGhs) {
    return refuse("over_cap", `Orders above GHS ${CAPS.walletOrderGhs} cannot be placed through chat. The user can order from the dashboard instead.`)
  }

  const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", ctx.userId).maybeSingle()
  const balanceBefore = wallet ? Number((wallet as any).balance) : null
  if (!schedule && (balanceBefore === null || !Number.isFinite(balanceBefore) || balanceBefore < price)) {
    return refuse("insufficient_balance", "The wallet balance is too low for this order. Ask the user to top up first.")
  }
  const before = balanceBefore !== null && Number.isFinite(balanceBefore) ? balanceBefore : 0
  const balanceAfter = round2(before - price)

  // Advisory duplicate check: a read error simply means no warning.
  const warnings: string[] = []
  let dupMinutesAgo: number | null = null
  try {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()
    const { data: dup, error: dupErr } = await db
      .from("orders")
      .select("created_at")
      .eq("user_id", ctx.userId)
      .eq("package_id", (pkg as any).id)
      .eq("phone_number", phone)
      .not("status", "in", "(failed,refunded,reversed)")
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
    if (dupErr) {
      console.error("prepare_wallet_order duplicate check failed")
    } else if (dup && dup.length > 0) {
      warnings.push("duplicate_recent")
      dupMinutesAgo = Math.max(1, Math.round((Date.now() - new Date((dup[0] as any).created_at).getTime()) / 60_000))
    }
  } catch {
    console.error("prepare_wallet_order duplicate check failed")
  }

  const recipientMasked = maskPhone(phone)
  const scheduleText = schedule ? describeSchedule(schedule, price) : undefined
  const lines: { label: string; value: string }[] = [
    { label: "Package", value: `${(pkg as any).network ?? input.network} ${input.size}` },
    { label: "Recipient", value: recipientMasked },
    { label: "Price", value: `GHS ${price.toFixed(2)}` },
    { label: "Balance now", value: `GHS ${before.toFixed(2)}` },
    { label: "Balance after", value: `GHS ${balanceAfter.toFixed(2)}` },
  ]
  if (scheduleText) lines.push({ label: "Schedule", value: scheduleText })
  if (dupMinutesAgo !== null) {
    lines.push({ label: "Heads up", value: `You ordered this for ${recipientMasked} ${dupMinutesAgo} min ago` })
  }

  const display: Record<string, unknown> = {
    title: schedule ? "Confirm scheduled order" : "Confirm data order",
    lines,
    recipientMasked,
    priceGhs: price,
    balanceBefore: before,
    balanceAfter,
    ...(scheduleText ? { scheduleText } : {}),
  }

  const draft = await createDraft(db, {
    userId: ctx.userId,
    context: "dashboard",
    action: "wallet_order",
    params: {
      packageId: (pkg as any).id,
      network: String(input.network),
      size: String(input.size),
      recipient: phone,
      price,
      balanceBefore: before,
      ...(schedule ? { schedule } : {}),
    },
    display,
    amountGhs: price,
    conversationKey: ctx.conversationKey,
    expiresInMs: EXPIRY_MS.dashboard,
  })

  return { draft_id: draft.id, display, expires_at: draft.expires_at, warnings }
}
