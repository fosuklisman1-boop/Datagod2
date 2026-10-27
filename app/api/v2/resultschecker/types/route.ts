import { withV2 } from "@/lib/api-v2/handler"
import { typesHandler } from "@/lib/api-v2/endpoints/results"
import { realResultsDeps } from "@/lib/api-v2/endpoints/results-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "standard", group: "status", endpoint: "/api/v2/resultschecker/types" },
  async (_req, ctx) => typesHandler(realResultsDeps())(ctx)
)
