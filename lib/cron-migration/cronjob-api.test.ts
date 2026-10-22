import { describe, it, expect, vi } from "vitest"
import { createClient } from "./cronjob-api"

const KEY = "key-SECRET-123"

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = []
  let i = 0
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses[Math.min(i++, responses.length - 1)]
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

describe("cronjob-api client", () => {
  it("listJobs parses jobs and sends the Bearer key", async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          jobs: [
            {
              jobId: 1,
              title: "t",
              url: "https://x/a",
              enabled: true,
              schedule: { timezone: "UTC", hours: [-1], mdays: [-1], minutes: [-1], months: [-1], wdays: [-1] },
            },
          ],
          someFailed: false,
        },
      },
    ])
    const c = createClient(KEY, { fetchImpl: f.impl, sleep: async () => {} })
    const jobs = await c.listJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ jobId: 1, url: "https://x/a", enabled: true })
    expect(f.calls[0].url).toBe("https://api.cron-job.org/jobs")
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(c.calls).toBe(1)
  })

  it("createJob PUTs {job} and returns jobId", async () => {
    const f = fakeFetch([{ status: 200, body: { jobId: 42 } }])
    const c = createClient(KEY, { fetchImpl: f.impl, sleep: async () => {} })
    const id = await c.createJob({ job: { url: "https://x/a" } })
    expect(id).toBe(42)
    expect(f.calls[0].init.method).toBe("PUT")
    expect(f.calls[0].url).toBe("https://api.cron-job.org/jobs")
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ job: { url: "https://x/a" } })
  })

  it("updateJob PATCHes /jobs/{id}", async () => {
    const f = fakeFetch([{ status: 200, body: {} }])
    const c = createClient(KEY, { fetchImpl: f.impl, sleep: async () => {} })
    await c.updateJob(7, { job: { enabled: true } })
    expect(f.calls[0].init.method).toBe("PATCH")
    expect(f.calls[0].url).toBe("https://api.cron-job.org/jobs/7")
  })

  it("throttles consecutive creates to stay under 5 PUT/min", async () => {
    const f = fakeFetch([{ status: 200, body: { jobId: 1 } }])
    const sleep = vi.fn(async () => {})
    const c = createClient(KEY, { fetchImpl: f.impl, sleep, createDelayMs: 13000 })
    await c.createJob({ job: {} })
    expect(sleep).not.toHaveBeenCalled()
    await c.createJob({ job: {} })
    expect(sleep).toHaveBeenCalledWith(13000)
  })

  it("throws on non-2xx without leaking the key, and does not retry a 429", async () => {
    const f = fakeFetch([{ status: 429, body: { error: `rate limited for ${KEY}` } }])
    const c = createClient(KEY, { fetchImpl: f.impl, sleep: async () => {} })
    await expect(c.listJobs()).rejects.toThrow(/429/)
    await c.listJobs().catch((e) => expect(String(e.message)).not.toContain(KEY))
    // two listJobs attempts above = exactly two fetches, no hidden retries
    expect(f.calls).toHaveLength(2)
  })
})
