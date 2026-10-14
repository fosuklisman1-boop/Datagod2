import type { CashbackConfig } from "@/lib/cashback/config"
import { isBillerKey, normaliseInputs, type BillerKey, type BillInputs } from "@/lib/bills/billers"
import { checkBotVerifyCaps, type BotCapDeps } from "./caps"
import type { BillsDeps, VerifyResult } from "@/lib/bills/service"
import { commissionBillGate, verifyBillMasked, type CommissionBillGate } from "@/lib/storefront-commission/bills"
import { fail } from "@/lib/storefront-commission/shop"
import { botBillerAllowed, botBinding, botGroupOn, resolveBotContext, GHANA_WATER_NOT_HERE, type BotContext, type BotSurface } from "./context"

/** Bots bills switch + Ghana Water rule + Phase 3a master/biller + Hubtel up (not paused) for that biller. */
export async function botBillGate(
  d: Pick<BillsDeps, "getCashbackConfig" | "getBillsConfig" | "getHubtelConfig">, surface: BotSurface, biller: BillerKey,
): Promise<CommissionBillGate> {
  if (!botBillerAllowed(surface, biller)) return fail(403, GHANA_WATER_NOT_HERE)
  return commissionBillGate(d, biller, (cfg: CashbackConfig) => botGroupOn(cfg, "bills"))
}

/**
 * Account lookup from a bot: the storefront's masked lookup with a token bound to "bot:<surface>:<shopId|main>".
 * Names are masked (response and token body); lookup failures carry fixed text. Ghana Water from a USSD bot => 403.
 */
export interface BotVerifyDeps extends BillsDeps { caps: BotCapDeps }

export async function botVerifyBill(
  d: BotVerifyDeps, ctx: BotContext, input: { biller: string } & BillInputs & { addMeter?: boolean; consent?: boolean },
): Promise<VerifyResult> {
  const c = resolveBotContext(ctx)
  if (!c.ok) return c
  const biller = input?.biller
  if (!isBillerKey(biller)) return fail(400, "Unknown biller")
  const g = await botBillGate(d, c.ctx.botSurface, biller)
  if (!g.ok) return g
  const { biller: _b, ...inputs } = input
  // Validate before counting (a typo never consumes a slot); count before the Hubtel query (no free enumeration).
  const n = normaliseInputs(biller, inputs)
  if (!n.ok) return fail(400, n.error)
  const capped = await checkBotVerifyCaps(d.caps, c.ctx)
  if (capped) return capped
  return verifyBillMasked(d, botBinding(c.ctx), biller, inputs)
}
