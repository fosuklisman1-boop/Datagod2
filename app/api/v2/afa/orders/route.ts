import { withV2 } from "@/lib/api-v2/handler"
import { afaListHandler } from "@/lib/api-v2/endpoints/afa"
import { realAfaDeps } from "@/lib/api-v2/endpoints/afa-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "standard", group: "status", endpoint: "/api/v2/afa/orders" },
  async (_req, ctx) => afaListHandler(realAfaDeps())(ctx)
)
