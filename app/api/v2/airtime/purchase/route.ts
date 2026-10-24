import { withV2 } from "@/lib/api-v2/handler"
import { purchaseAirtimeHandler } from "@/lib/api-v2/endpoints/airtime"
import { realAirtimeDeps } from "@/lib/api-v2/endpoints/airtime-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// purchaseAirtime awaits the provider dispatch (Hubtel/Digiwapy) inside the
// request. A function killed mid-call leaves the claim in_progress (it reads
// as OUTCOME_UNKNOWN later, never re-run), so give the engine the full 300 s.
export const maxDuration = 300

export const POST = withV2(
  {
    requiredType: "commission",
    group: "purchase",
    endpoint: "/api/v2/airtime/purchase",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => purchaseAirtimeHandler(realAirtimeDeps())(await readJsonBody(req), ctx)
)
