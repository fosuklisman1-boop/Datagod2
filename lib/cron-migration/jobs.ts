import { cronToSchedule, type JobSchedule } from "./schedule"

export type Batch = "A" | "B" | "C"

export type JobSpec = {
  path: string
  cron: string
  title: string
  url: string
  schedule: JobSchedule
  batch: Batch
  /** Money / order-fulfillment / provider-status jobs: moved last, one at a time, failure-alerted. */
  fulfillment: boolean
}

/** Prefix that marks a cron-job.org job as owned by this migration script. */
export const TITLE_PREFIX = "dg:"

const P = "/api/cron/"

// Batch A: daily / hourly / every-5-minutes-or-slower, non-fulfillment.
const BATCH_A = new Set(
  [
    "check-subscription-expiry",
    "check-subscriptions",
    "mtn-whitelist-retry",
    "sms-kyc-purge",
    "release-held-mtn-orders",
    "sms-senderid-poll",
    "check-mtn-balance",
    "sms-contact-verify",
    "sms-delivery-sync",
    "expire-stale-airtime",
  ].map((n) => P + n),
)

// Batch B: every 1-2 minutes, non-fulfillment.
const BATCH_B = new Set(
  [
    "run-ai-tasks",
    "drain-broadcasts",
    "wa-delivery-notify",
    "sms-pending-credits",
    "sms-send-drain",
    "sms-scheduled",
    "sms-hubtel-dlr",
    "security-alerts",
    "phone-verify",
  ].map((n) => P + n),
)

// Batch C (fulfillment): provider status syncs + money jobs.
const C_PREFIXES = [
  P + "sync-mtn-status",
  P + "sync-afa-status",
  P + "sync-codecraft-status",
  P + "sync-digiwapy",
]
const C_EXACT = new Set(
  [
    "hubtel-callbacks",
    "hubtel-status-check",
    "hubtel-cs-status-check",
    "verify-pending-payments",
    "withdrawals-status-check",
    "drain-fulfillment-queue",
    "reconcile-paystack-refunds",
  ].map((n) => P + n),
)

function classify(path: string): { batch: Batch; fulfillment: boolean } {
  if (C_EXACT.has(path) || C_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
    return { batch: "C", fulfillment: true }
  }
  if (BATCH_A.has(path)) return { batch: "A", fulfillment: false }
  if (BATCH_B.has(path)) return { batch: "B", fulfillment: false }
  throw new Error(`unclassified cron path: ${path} (add it to a batch in lib/cron-migration/jobs.ts)`)
}

export function buildJobSpecs(
  vercelCrons: { path: string; schedule: string }[],
  host: string,
): JobSpec[] {
  return vercelCrons.map((c) => ({
    path: c.path,
    cron: c.schedule,
    title: TITLE_PREFIX + c.path,
    url: host.replace(/\/+$/, "") + c.path,
    schedule: cronToSchedule(c.schedule),
    ...classify(c.path),
  }))
}

/** Body for PUT /jobs (create) and, minus nothing, PATCH /jobs/{id} (update). Jobs are created DISABLED. */
export function toCreatePayload(spec: JobSpec, cronSecret: string): object {
  const job: Record<string, unknown> = {
    url: spec.url,
    title: spec.title,
    enabled: false,
    saveResponses: false,
    requestMethod: 0, // GET
    schedule: { ...spec.schedule, expiresAt: 0 },
    extendedData: { headers: { Authorization: `Bearer ${cronSecret}` } },
  }
  if (spec.fulfillment) {
    job.notification = { onFailure: true, onFailureCount: 3 }
  }
  return { job }
}

export function redactSecret(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join("[REDACTED]")
}
