/**
 * Admin "Check all providers": asks EVERY configured whitelist provider (not just the checkout list)
 * about a set of numbers. Read-only and nothing is persisted. An approval from a provider outside the
 * checkout list is information for the admin only (allowedOutsideCheckout); only allowedByCheckout may
 * ever move a row to allowed. Logs carry counts only.
 *
 * Each provider is called in chunks of 10 phones, at most 5 chunks in flight, and no new chunk starts
 * after the start deadline (40 s). Finished chunks keep their answers; everything else is "error".
 * Entries without checkBatchStrict are "error": their checkBatch fails open to allowed.
 */

import { WHITELIST_REGISTRY, type WhitelistEntry } from "@/lib/mtn-providers/provider-whitelist"
import { getCustomerVerificationSettings } from "@/lib/mtn-providers/customer-verification"
import { normalizeGhanaPhone } from "@/lib/phone-format"

export type Cell = "allowed" | "refused" | "error"

export type AllProvidersRow = {
  phone: string
  results: Record<string, Cell>
  allowedByCheckout: boolean
  allowedOutsideCheckout: string[]
}

export type AllProvidersResult = {
  providers: string[]
  checkoutProviders: string[]
  /** Providers that errored for every phone. */
  failedProviders: string[]
  rows: AllProvidersRow[]
}

export type AllProvidersDeps = {
  registry: WhitelistEntry[]
  getSettings: () => Promise<{ providers: string[] }>
  /** Hard bound per provider. Default 45 s so the whole call stays under ~60 s. */
  timeoutMs?: number
  /** No chunk starts once this much time has elapsed. Default 40 s. */
  startDeadlineMs?: number
  /** Millisecond clock, injectable for tests. */
  now?: () => number
  chunkSize?: number
  concurrency?: number
}

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_START_DEADLINE_MS = 40_000
const DEFAULT_CHUNK = 10
const DEFAULT_CONCURRENCY = 5

async function askProvider(
  entry: WhitelistEntry,
  phones: string[],
  o: { timeoutMs: number; startDeadlineMs: number; now: () => number; chunkSize: number; concurrency: number }
): Promise<Map<string, Cell>> {
  const answers = new Map<string, Cell>()
  const call = entry.checkBatchStrict
  if (!call) return answers // no strict mode: cannot tell "allowed" from a fail-open default

  const normalised = phones.map((p) => normalizeGhanaPhone(p) ?? p)
  const chunks: string[][] = []
  for (let i = 0; i < normalised.length; i += o.chunkSize) chunks.push(normalised.slice(i, i + o.chunkSize))

  const started = o.now()
  let next = 0
  const worker = async () => {
    while (next < chunks.length && o.now() - started < o.startDeadlineMs) {
      const chunk = chunks[next++]
      try {
        const answer = await call(chunk)
        if (!Array.isArray(answer)) continue
        for (const r of answer) {
          const key = typeof r?.msisdn === "string" ? normalizeGhanaPhone(r.msisdn) ?? r.msisdn : null
          if (key) answers.set(key, r.allowed === true ? "allowed" : "refused")
        }
      } catch {
        // this chunk's phones stay unanswered -> error
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const workers = Promise.all(Array.from({ length: Math.min(o.concurrency, chunks.length) }, worker))
  await Promise.race([
    workers,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, o.timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  // Anything still running after this point is ignored: a late answer must not change the result.
  return new Map(answers)
}

export async function checkAllProviders(
  phones: string[],
  deps?: Partial<AllProvidersDeps>
): Promise<AllProvidersResult> {
  const registry = deps?.registry ?? WHITELIST_REGISTRY
  const getSettings = deps?.getSettings ?? getCustomerVerificationSettings
  const opts = {
    timeoutMs: deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    startDeadlineMs: deps?.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS,
    now: deps?.now ?? (() => Date.now()),
    chunkSize: deps?.chunkSize ?? DEFAULT_CHUNK,
    concurrency: deps?.concurrency ?? DEFAULT_CONCURRENCY,
  }

  const configured = registry.filter((p) => p.configured())
  const providers = configured.map((p) => p.name)
  const settings = await getSettings().catch(() => ({ providers: [] as string[] }))
  const checkoutProviders = (settings.providers ?? []).filter((n) => providers.includes(n))

  const answers = await Promise.all(configured.map((e) => askProvider(e, phones, opts)))

  const rows: AllProvidersRow[] = phones.map((phone) => {
    const key = normalizeGhanaPhone(phone) ?? phone
    const results: Record<string, Cell> = {}
    configured.forEach((e, i) => {
      results[e.name] = answers[i].get(key) ?? "error"
    })
    return {
      phone,
      results,
      allowedByCheckout: checkoutProviders.some((n) => results[n] === "allowed"),
      allowedOutsideCheckout: providers.filter((n) => results[n] === "allowed" && !checkoutProviders.includes(n)),
    }
  })

  const failedProviders = phones.length === 0 ? [] : providers.filter((n) => rows.every((r) => r.results[n] === "error"))
  console.log(`[BLOCKED-ADMIN] check-all providers=${providers.length} phones=${phones.length} failedProviders=${failedProviders.length}`)
  return { providers, checkoutProviders, failedProviders, rows }
}
