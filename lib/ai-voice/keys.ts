// Several Nuance accounts (beta): NUANCE_API_KEY is account 1, NUANCE_API_KEY_2..NUANCE_API_KEY_9 the rest.
// Owner-approved for the Nuance beta (Nuance support said multiple accounts are fine until the beta ends);
// the admin switch voice.multiAccount turns it off, leaving account 1 only.

export interface NuanceKey { index: number; key: string }

export const MAX_NUANCE_ACCOUNTS = 9

export function nuanceKeys(env: Record<string, string | undefined> = process.env): NuanceKey[] {
  const out: NuanceKey[] = []
  for (let i = 1; i <= MAX_NUANCE_ACCOUNTS; i++) {
    const key = (i === 1 ? env.NUANCE_API_KEY : env[`NUANCE_API_KEY_${i}`])?.trim()
    if (key) out.push({ index: i, key })
  }
  return out
}

/**
 * Accounts to try for a new call, in order. Switched off: account 1 only (its own limits answer).
 * Switched on: every account whose open calls are below callsPerKey. An account out of credits is still listed:
 * the mint answers credits_spent at once and the caller moves on to the next.
 */
export function candidateKeys(
  keys: NuanceKey[],
  opts: { multiAccount: boolean; callsPerKey: number; openByKey: Record<number, number> },
): NuanceKey[] {
  if (!opts.multiAccount) return keys.filter((k) => k.index === 1)
  return keys.filter((k) => (opts.openByKey[k.index] ?? 0) < opts.callsPerKey)
}
