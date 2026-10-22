import type { RefundGateway } from "../types"
import { paystackGateway } from "./paystack"
import { paystackPayoutGateway } from "./paystack-payout"
import { moolreGateway } from "./moolre"
import { hubtelGateway } from "./hubtel"
import { walletGateway } from "./wallet"
import { manualGateway } from "./manual"

// To add a gateway: implement RefundGateway in its own file and append it here.
// Manual stays LAST: the refund dialog pre-selects the first supported gateway, and that must be a real payout.
const GATEWAYS: RefundGateway[] = [paystackGateway, paystackPayoutGateway, moolreGateway, hubtelGateway, walletGateway, manualGateway]

export const listGateways = (): RefundGateway[] => GATEWAYS
export const getGateway = (id: string): RefundGateway | undefined => GATEWAYS.find((g) => g.id === id)
