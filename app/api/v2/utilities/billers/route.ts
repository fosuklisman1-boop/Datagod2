import { withV2 } from "@/lib/api-v2/handler"
import { billersHandler } from "@/lib/api-v2/endpoints/bills"
import { realBillsDeps } from "@/lib/api-v2/endpoints/bills-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "commission", group: "status", endpoint: "/api/v2/utilities/billers" },
  async (_req, ctx) => billersHandler(realBillsDeps())(ctx)
)
