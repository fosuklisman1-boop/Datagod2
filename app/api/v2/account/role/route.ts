import { withV2 } from "@/lib/api-v2/handler"
import { mapRole } from "@/lib/api-v2/endpoints/account"

export const dynamic = "force-dynamic"

export const GET = withV2(
  { requiredType: "standard", group: "status", endpoint: "/api/v2/account/role" },
  async (_req, ctx) => ({ status: 200, data: mapRole(ctx) })
)
