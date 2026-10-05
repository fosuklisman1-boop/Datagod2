import type { RefundGateway } from "../types"
import { paystackGateway } from "./paystack"
import { paystackPayoutGateway } from "./paystack-payout"
import { moolreGateway } from "./moolre"
import { walletGateway } from "./wallet"

// To add a gateway: implement RefundGateway in its own file and append it here.
const GATEWAYS: RefundGateway[] = [paystackGateway, paystackPayoutGateway, moolreGateway, walletGateway]

export const listGateways = (): RefundGateway[] => GATEWAYS
export const getGateway = (id: string): RefundGateway | undefined => GATEWAYS.find((g) => g.id === id)
