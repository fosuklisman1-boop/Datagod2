import { WHITELIST_REGISTRY, type WhitelistEntry } from "@/lib/mtn-providers/provider-whitelist"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import type { Answer } from "./verdicts"

export type { Answer }

const DEFAULT_TIMEOUT_MS = 5000

function strictEntry(supplier: string, registry: WhitelistEntry[]): WhitelistEntry | undefined {
  return registry.find((e) => e.name === supplier && typeof e.checkBatchStrict === "function")
}

/** True when the supplier has a strict check, is configured, and is not switched off. */
export function canCheck(supplier: string, disabled: Set<string>, registry: WhitelistEntry[] = WHITELIST_REGISTRY): boolean {
  const entry = strictEntry(supplier, registry)
  if (!entry || disabled.has(supplier)) return false
  try {
    return entry.configured()
  } catch {
    return false
  }
}

/**
 * Ask ONE supplier about ONE number via its strict batch check (the
 * non-strict ones fail open). A definite answer is yes/no; a throw, a timeout
 * or no row matching the number is no_answer. Never throws; never logs the phone.
 * `registry` is injectable for tests.
 */
export async function askSupplier(
  supplier: string,
  phone: string,
  opts: { timeoutMs?: number; registry?: WhitelistEntry[] } = {}
): Promise<Answer> {
  const entry = strictEntry(supplier, opts.registry ?? WHITELIST_REGISTRY)
  if (!entry || !normalizeGhanaPhone(phone)) return "no_answer"
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
    const rows = await Promise.race([entry.checkBatchStrict!([phone]), timeout])
    const want = normalizeGhanaPhone(phone)
    const row = (Array.isArray(rows) ? rows : []).find((r) => normalizeGhanaPhone(String(r?.msisdn ?? "")) === want)
    // Only a real boolean is a definite answer; anything else never counts as a "no".
    if (!row || typeof row.allowed !== "boolean") return "no_answer"
    return row.allowed ? "yes" : "no"
  } catch {
    return "no_answer"
  } finally {
    if (timer) clearTimeout(timer)
  }
}
