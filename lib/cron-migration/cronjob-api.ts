/**
 * Minimal cron-job.org REST client (https://docs.cron-job.org/rest-api.html, checked 2026-10-20).
 *
 * Shape notes:
 *  - GET  /jobs            -> { jobs: [{ jobId, title, url, enabled, schedule, ... }], someFailed }
 *  - PUT  /jobs            -> body { job: {...} }, returns { jobId }
 *  - PATCH /jobs/{id}      -> body { job: {changed fields} }, returns {}
 *  - schedule: { timezone, expiresAt, hours[], mdays[], minutes[], months[], wdays[] }, -1 = every
 *  - extendedData.headers is an OBJECT; requestMethod 0 = GET; notification { onFailure, onFailureCount }
 *  - There is no retry setting in the API.
 *  - Limits: 100 requests/day (default plan); PUT /jobs additionally 1/s and 5/min;
 *    GET/PATCH/DELETE 5/s. Hence the create throttle below and NO automatic retries -
 *    a retry would silently burn the daily budget.
 */
import type { ExistingJob } from "./plan"
import { redactSecret } from "./jobs"

const BASE = "https://api.cron-job.org"

export type ClientOptions = {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Minimum gap between PUT /jobs calls. 13s keeps us under 5 creates/minute. */
  createDelayMs?: number
}

export function createClient(apiKey: string, opts: ClientOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const createDelayMs = opts.createDelayMs ?? 13000
  let creates = 0
  const state = { calls: 0 }

  async function request(method: string, path: string, body?: unknown): Promise<any> {
    state.calls++
    const res = await fetchImpl(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`cron-job.org ${method} ${path} failed: ${res.status} ${redactSecret(text, apiKey).slice(0, 200)}`)
    }
    return text ? JSON.parse(text) : {}
  }

  return {
    get calls() {
      return state.calls
    },
    async listJobs(): Promise<ExistingJob[]> {
      const data = await request("GET", "/jobs")
      return (data.jobs ?? []).map((j: any) => ({
        jobId: j.jobId,
        title: j.title ?? "",
        url: j.url,
        enabled: !!j.enabled,
        schedule: j.schedule,
      }))
    },
    async createJob(payload: object): Promise<number> {
      if (creates++ > 0) await sleep(createDelayMs)
      const data = await request("PUT", "/jobs", payload)
      return data.jobId as number
    },
    async updateJob(jobId: number, payload: object): Promise<void> {
      await request("PATCH", `/jobs/${jobId}`, payload)
    },
  }
}

export type CronJobClient = ReturnType<typeof createClient>
