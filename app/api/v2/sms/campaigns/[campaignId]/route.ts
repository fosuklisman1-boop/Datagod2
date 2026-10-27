import { withV2 } from "@/lib/api-v2/handler"
import { handleSmsCampaign } from "@/lib/api-v2/endpoints/sms"
import { realSmsDeps } from "@/lib/api-v2/endpoints/sms-deps"
import { referenceFromPath } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// The campaign id is the send log id of the FIRST batch of a send (read from the path: withV2
// handlers receive only the request). A foreign or missing id is the same 404.
export const GET = withV2(
  { requiredType: "sms", group: "status", endpoint: "/api/v2/sms/campaigns/[campaignId]" },
  async (req, ctx) => handleSmsCampaign(realSmsDeps())(referenceFromPath(req.nextUrl.pathname), ctx)
)
