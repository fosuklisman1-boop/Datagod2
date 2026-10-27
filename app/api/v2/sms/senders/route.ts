import { withV2 } from "@/lib/api-v2/handler"
import { handleSmsSenders } from "@/lib/api-v2/endpoints/sms"
import { realSmsDeps } from "@/lib/api-v2/endpoints/sms-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "sms", group: "status", endpoint: "/api/v2/sms/senders" },
  async (_req, ctx) => handleSmsSenders(realSmsDeps())(ctx)
)
