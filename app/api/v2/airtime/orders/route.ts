import { withV2 } from "@/lib/api-v2/handler"
import { airtimeListHandler } from "@/lib/api-v2/endpoints/airtime"
import { realAirtimeDeps } from "@/lib/api-v2/endpoints/airtime-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "commission", group: "status", endpoint: "/api/v2/airtime/orders" },
  async (_req, ctx) => airtimeListHandler(realAirtimeDeps())(ctx)
)
