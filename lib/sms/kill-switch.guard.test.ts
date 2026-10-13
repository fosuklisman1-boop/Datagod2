import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"

// The kill switch must never gate the drain, DLR polling, dispatch, or the Paystack webhook
// (payments already made must still credit). Guard against the gate silently spreading there.
const NEVER_GATED = [
  "lib/sms/send-drain.ts",
  "lib/sms/delivery-poll.ts",
  "lib/sms/campaign-dispatch.ts",
  "app/api/webhooks/paystack/route.ts",
]

describe("kill switch never gates drain / DLR / dispatch / paystack webhook", () => {
  for (const rel of NEVER_GATED) {
    it(rel, () => {
      const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8")
      expect(src).not.toContain("kill-switch")
      expect(src).not.toContain("isSmsEnabled")
    })
  }
})
