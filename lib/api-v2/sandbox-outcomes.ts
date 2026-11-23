// Reserved sandbox (test-key) recipient numbers that force a data order to fail or stay pending.
// Pure and sandbox-only: nothing here is read by the live order path or by v1.

export const SANDBOX_FAIL_SUFFIX = "0000404"
export const SANDBOX_STUCK_SUFFIX = "0000202"

export type SandboxOutcome = "fail" | "stuck"

/** Local 10-digit number: network prefix 02x/03x/05x, then a digit, then the reserved suffix. */
export function sandboxOutcomeFor(local: string): SandboxOutcome | null {
  if (/^0[235][0-9]0000404$/.test(local)) return "fail"
  if (/^0[235][0-9]0000202$/.test(local)) return "stuck"
  return null
}

export const SANDBOX_TEST_NUMBERS: { fail: readonly string[]; stuck: readonly string[] } = {
  fail: ["0240000404", "0200000404", "0270000404"],
  stuck: ["0240000202", "0200000202", "0270000202"],
}
