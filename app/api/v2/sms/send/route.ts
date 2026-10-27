import { withV2 } from "@/lib/api-v2/handler"
import { handleSmsSend } from "@/lib/api-v2/endpoints/sms"
import { realSmsDeps } from "@/lib/api-v2/endpoints/sms-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// enqueueSendBatched sends up to 5000 recipients as sequential 500-recipient batches (v1 also uses
// 300 s). A function killed mid-call leaves the claim in_progress (it reads as OUTCOME_UNKNOWN later,
// never re-run), so give the engine the full 300 s. 300 s stays below CLAIM_STALE_MS (600 s).
export const maxDuration = 300

export const POST = withV2(
  {
    requiredType: "sms",
    group: "purchase",
    endpoint: "/api/v2/sms/send",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => handleSmsSend(realSmsDeps())(await readJsonBody(req), ctx)
)
