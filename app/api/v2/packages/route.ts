import { withV2 } from "@/lib/api-v2/handler"
import { listPackagesHandler } from "@/lib/api-v2/endpoints/data"
import { realDataDeps } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "standard", group: "status", endpoint: "/api/v2/packages" },
  async (req, ctx) =>
    listPackagesHandler(realDataDeps())(
      {
        network: req.nextUrl.searchParams.get("network"),
        size_gb: req.nextUrl.searchParams.get("size_gb"),
      },
      ctx
    )
)
