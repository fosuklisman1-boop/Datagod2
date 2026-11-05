// A time limit on the shop bot's charge, so a hung call ends well inside the webhook's maxDuration (60 s) and the
// claim's TTL (75 s), instead of the function being killed mid-charge.
//
// A timeout is an UNKNOWN outcome: a prompt may already be on its way. The caller never fails the order and never
// tells the customer it failed. The charge itself can't be cancelled, but its Paystack call is gated: once the time is
// up, a Paystack charge that had not started yet (a fallback after a slow Hubtel answer) is refused, so a timeout
// can never turn into a second prompt on another gateway.
//
// Usage: const gate = chargeGate(); const timed = await gate.race(startUssdCharge(input, gate.deps))
import { chargeMobileMoney } from "@/lib/paystack"
import { FallbackRefusedError, type StartDeps } from "@/lib/payment-gateway/start"

/** Mutable for tests only. */
export const chargeTimeout = { ms: 40_000 }

export type TimedCharge<T> = { kind: "done"; value: T } | { kind: "timeout" }

export interface ChargeGate {
  /** Pass to startUssdCharge / startMomoCharge: the gated Paystack charge. */
  deps: Partial<StartDeps>
  race<T>(work: Promise<T>): Promise<TimedCharge<T>>
}

export function chargeGate(): ChargeGate {
  let timedOut = false
  const gatedCharge: StartDeps["chargeMobileMoney"] = async (params) => {
    if (timedOut) throw new FallbackRefusedError()
    return chargeMobileMoney(params)
  }
  return {
    deps: { chargeMobileMoney: gatedCharge },
    async race<T>(work: Promise<T>): Promise<TimedCharge<T>> {
      let timer: ReturnType<typeof setTimeout> | undefined
      const limit = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), chargeTimeout.ms) })
      try {
        const first = await Promise.race([work.then((value) => ({ value })), limit])
        if (first === "timeout") {
          timedOut = true
          // Whatever the late charge does now is settled by its webhook or the sweep; never an unhandled rejection.
          work.catch((e) => console.error("[WA-SHOP-CHARGE] charge ended after the timeout:", e instanceof Error ? e.name : "unknown error"))
          return { kind: "timeout" }
        }
        return { kind: "done", value: first.value }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
