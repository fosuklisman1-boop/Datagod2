import { withV2 } from "@/lib/api-v2/handler"
import { billPayHandler } from "@/lib/api-v2/endpoints/bills"
import { realBillsDeps } from "@/lib/api-v2/endpoints/bills-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// payBill dispatches to Hubtel inside the request after the debit. Like the
// v1 pay route, a request must always die well before the engine's 5-minute
// stuck-dispatch threshold, so it is bounded at 60 s. A function killed
// mid-call leaves the claim in_progress: it reads as REQUEST_IN_PROGRESS and
// then OUTCOME_UNKNOWN, never re-run.
export const maxDuration = 60

export const POST = withV2(
  {
    requiredType: "commission",
    group: "purchase",
    endpoint: "/api/v2/utilities/pay",
    fallbackLimitWhenDegraded: true,
  },
  async (req, ctx) => billPayHandler(realBillsDeps())(await readJsonBody(req), ctx)
)
