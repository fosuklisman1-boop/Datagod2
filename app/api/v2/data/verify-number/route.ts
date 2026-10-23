import { withV2 } from "@/lib/api-v2/handler"
import { verifyNumberHandler } from "@/lib/api-v2/endpoints/data"
import { readJsonBody, realDataDeps } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const POST = withV2(
  { requiredType: "standard", group: "status", endpoint: "/api/v2/data/verify-number" },
  async (req, ctx) => verifyNumberHandler(realDataDeps())(await readJsonBody(req), ctx)
)
