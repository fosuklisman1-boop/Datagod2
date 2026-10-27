import { withV2 } from "@/lib/api-v2/handler"
import { handleSmsCampaigns } from "@/lib/api-v2/endpoints/sms"
import { realSmsDeps } from "@/lib/api-v2/endpoints/sms-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "sms", group: "status", endpoint: "/api/v2/sms/campaigns" },
  async (req, ctx) =>
    handleSmsCampaigns(realSmsDeps())(
      { page: req.nextUrl.searchParams.get("page"), status: req.nextUrl.searchParams.get("status") },
      ctx
    )
)
