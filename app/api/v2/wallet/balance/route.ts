import { withV2 } from "@/lib/api-v2/handler"
import { getAdminClient } from "@/lib/api-v2/store"
import { mapBalance } from "@/lib/api-v2/endpoints/account"
import { getSandboxBalance } from "@/lib/sandbox"

export const dynamic = "force-dynamic"

export const GET = withV2(
  { requiredType: "standard", group: "balance", endpoint: "/api/v2/wallet/balance" },
  async (_req, ctx) => {
    if (ctx.environment === "test") {
      const balance = await getSandboxBalance(ctx.userId)
      return { status: 200, data: { balance, currency: "GHS", sandbox: true } }
    }
    const { data, error } = await getAdminClient()
      .from("wallets")
      .select("balance, total_credited, total_spent")
      .eq("user_id", ctx.userId)
      .single()
    const mapped = error ? null : mapBalance(data)
    if (!mapped) {
      return { status: 500, error: { status: 500, message: "Failed to fetch wallet balance" } }
    }
    return { status: 200, data: mapped }
  }
)
