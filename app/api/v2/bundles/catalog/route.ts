import { withV2 } from "@/lib/api-v2/handler"
import { bundleCatalogHandler } from "@/lib/api-v2/endpoints/bundles"
import { realBundleDeps } from "@/lib/api-v2/endpoints/bundles-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = withV2(
  { requiredType: "commission", group: "status", endpoint: "/api/v2/bundles/catalog" },
  async (req, ctx) => bundleCatalogHandler(realBundleDeps())(req.nextUrl.searchParams.get("network"), ctx)
)
