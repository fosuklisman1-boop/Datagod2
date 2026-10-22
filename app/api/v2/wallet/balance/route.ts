import { withV2 } from "@/lib/api-v2/handler"
import { getAdminClient } from "@/lib/api-v2/store"
import { readBalance } from "@/lib/api-v2/endpoints/account"
import { getSandboxBalance } from "@/lib/sandbox"

export const dynamic = "force-dynamic"

export const GET = withV2(
  { requiredType: "standard", group: "balance", endpoint: "/api/v2/wallet/balance" },
  async (_req, ctx) =>
    readBalance(ctx, { wallets: getAdminClient(), sandboxBalance: getSandboxBalance })
)
