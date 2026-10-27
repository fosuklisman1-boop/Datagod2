import { withV2 } from "@/lib/api-v2/handler"
import { handleSmsBalance } from "@/lib/api-v2/endpoints/sms"
import { realSmsDeps } from "@/lib/api-v2/endpoints/sms-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "sms", group: "balance", endpoint: "/api/v2/sms/balance" },
  async (_req, ctx) => handleSmsBalance(realSmsDeps())(ctx)
)
