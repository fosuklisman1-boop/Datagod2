import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"
import { subAgentCosts } from "@/lib/shop-commerce/pricing"

// "Set your prices and go live" reminders for storefront joiners (migration 0149).
// A joiner (user_shops.joined_via='storefront') stays closed until they save prices; user_shops.created_at is the
// join time. Each joiner gets an SMS + email at 10 min, 48 h and 72 h after joining, until the shop opens
// (prices_set_at set or is_active) or is blocked. price_reminders_sent is the last stage handled (sent OR skipped).
// - Overdue (e.g. a job outage): only the latest due stage is sent, once; earlier ones are marked passed.
// - Joiner can't price at a stage's time (no parent, parent offers nothing): that stage is skipped, not deferred.
// - A catalog READ error is not "can't price": the stage is left unclaimed and retried next run.
// - Each stage is claimed with a conditional UPDATE before sending, so overlapping runs send at most once.

type Db = any

const MIN = 60 * 1000
const HOUR = 60 * MIN
/** Stage n (1-based) is due once this long has passed since joining. */
export const PRICE_REMINDER_THRESHOLDS_MS = [10 * MIN, 48 * HOUR, 72 * HOUR] as const
export const PRICE_REMINDER_LINK = "https://www.datagod.store/dashboard/shop-pricing?setup=1"
const SCAN_LIMIT = 100
const TYPE = "sub_agent_price_reminder"

export interface PriceReminderDeps {
  sendSMS: typeof sendSMS
  sendEmail: typeof sendEmail
  subAgentCosts: typeof subAgentCosts
}

export function defaultPriceReminderDeps(): PriceReminderDeps {
  return { sendSMS, sendEmail, subAgentCosts }
}

export interface PriceReminderResult {
  scanned: number
  sent: number
  skipped_no_catalog: number
  claimed_elsewhere: number
  /** Parent offer could not be read: stage left unclaimed for the next run. */
  read_errors: number
}

/** Highest stage (1..3) whose threshold has passed and is above `sent`; 0 when none. */
export function reminderStageDue(createdAt: Date, now: Date, sent: number): number {
  const elapsed = now.getTime() - createdAt.getTime()
  if (!Number.isFinite(elapsed)) return 0
  for (let i = PRICE_REMINDER_THRESHOLDS_MS.length - 1; i >= 0; i--) {
    if (elapsed >= PRICE_REMINDER_THRESHOLDS_MS[i]) return i + 1 > sent ? i + 1 : 0
  }
  return 0
}

/** Error text for logs with phone numbers and email addresses removed. */
function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error"
  return raw
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]")
    .slice(0, 200)
}

/** Rows that have a due stage: a row is returned only when its next stage's threshold has passed. */
function dueFilter(now: Date): string {
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const [t1, t2, t3] = PRICE_REMINDER_THRESHOLDS_MS
  return [
    `and(price_reminders_sent.lt.1,created_at.lte.${at(t1)})`,
    `and(price_reminders_sent.lt.2,created_at.lte.${at(t2)})`,
    `and(price_reminders_sent.lt.3,created_at.lte.${at(t3)})`,
  ].join(",")
}

export async function runPriceReminders(
  db: Db,
  now: Date = new Date(),
  deps: PriceReminderDeps = defaultPriceReminderDeps()
): Promise<PriceReminderResult> {
  const result: PriceReminderResult = { scanned: 0, sent: 0, skipped_no_catalog: 0, claimed_elsewhere: 0, read_errors: 0 }

  const { data: rows, error } = await db
    .from("user_shops")
    .select("id, user_id, parent_shop_id, created_at, price_reminders_sent, is_active, is_blocked, prices_set_at, joined_via")
    .eq("joined_via", "storefront")
    .is("prices_set_at", null)
    .eq("is_active", false)
    .not("is_blocked", "is", true)
    .lt("price_reminders_sent", PRICE_REMINDER_THRESHOLDS_MS.length)
    .or(dueFilter(now))
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT)
  if (error) throw new Error(`Could not read storefront joiners: ${error.code ?? ""} ${safeError(error.message)}`.trim())

  // Defence in depth: never act on an open, blocked or non-storefront row even if the query let one through.
  const candidates: any[] = (Array.isArray(rows) ? rows : []).filter(
    (r) => r.joined_via === "storefront" && r.prices_set_at == null && r.is_active !== true && r.is_blocked !== true
  )
  result.scanned = candidates.length
  if (candidates.length === 0) return result

  // Contacts: user_shops.user_id references auth.users, so public.users is read explicitly by id.
  const userIds = [...new Set(candidates.map((r) => r.user_id).filter(Boolean))]
  const contacts = new Map<string, { phone_number?: string | null; email?: string | null }>()
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await db.from("users").select("id, phone_number, email").in("id", userIds)
    if (usersError) throw new Error(`Could not read joiner contacts: ${usersError.code ?? ""}`.trim())
    for (const u of users ?? []) contacts.set(u.id, u)
  }

  // One read of each parent's offer per run. true = offers at least one package; null = read failed.
  const canPrice = new Map<string, boolean | null>()
  async function parentOffers(parentShopId: string): Promise<boolean | null> {
    if (!canPrice.has(parentShopId)) {
      try {
        const { costs } = await deps.subAgentCosts(parentShopId, null, db)
        canPrice.set(parentShopId, [...costs.values()].some((o) => o != null))
      } catch (err) {
        console.warn(`[PRICE-REMINDERS] parent offer read failed parent=${parentShopId}: ${safeError(err)}`)
        canPrice.set(parentShopId, null)
      }
    }
    return canPrice.get(parentShopId)!
  }

  for (const row of candidates) {
    const sent = Number(row.price_reminders_sent ?? 0)
    const stage = reminderStageDue(new Date(row.created_at), now, sent)
    if (stage === 0) continue

    const offers = row.parent_shop_id ? await parentOffers(String(row.parent_shop_id)) : false
    if (offers === null) {
      result.read_errors++
      continue
    }

    // Claim the stage. Only the run whose UPDATE returns the row acts on it; the shop must still be closed.
    const { data: claimed, error: claimError } = await db
      .from("user_shops")
      .update({ price_reminders_sent: stage })
      .eq("id", row.id)
      .eq("price_reminders_sent", sent)
      .eq("joined_via", "storefront")
      .is("prices_set_at", null)
      .eq("is_active", false)
      .not("is_blocked", "is", true)
      .select("id")
    if (claimError) {
      console.warn(`[PRICE-REMINDERS] claim failed shop=${row.id} stage=${stage}: ${claimError.code ?? ""}`)
      continue
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      result.claimed_elsewhere++
      continue
    }

    if (!offers) {
      result.skipped_no_catalog++
      continue
    }

    result.sent++
    const contact = contacts.get(row.user_id)
    if (contact?.phone_number) {
      try {
        const res = await deps.sendSMS({
          phone: contact.phone_number,
          message: SMSTemplates.subAgentPriceReminder(stage),
          type: TYPE,
          reference: row.id,
          userId: row.user_id,
        })
        if (res && res.success === false) {
          console.warn(`[PRICE-REMINDERS] SMS not sent shop=${row.id} stage=${stage}: ${safeError(res.error)}`)
        }
      } catch (err) {
        console.warn(`[PRICE-REMINDERS] SMS failed shop=${row.id} stage=${stage}: ${safeError(err)}`)
      }
    }
    if (contact?.email) {
      try {
        const template = EmailTemplates.subAgentPriceReminder(stage, PRICE_REMINDER_LINK)
        const res = await deps.sendEmail({
          to: [{ email: contact.email }],
          subject: template.subject,
          htmlContent: template.html,
          userId: row.user_id,
          type: TYPE,
        })
        if (res && res.success === false) {
          console.warn(`[PRICE-REMINDERS] email not sent shop=${row.id} stage=${stage}: ${safeError(res.error)}`)
        }
      } catch (err) {
        console.warn(`[PRICE-REMINDERS] email failed shop=${row.id} stage=${stage}: ${safeError(err)}`)
      }
    }
  }

  return result
}
