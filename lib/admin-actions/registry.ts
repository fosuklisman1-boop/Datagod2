import { afaFlow } from "./flows/afa"
import { complaintFlow } from "./flows/complaint"
import { resultsCheckFlow } from "./flows/results-check"
import { senderIdFlow } from "./flows/sender-id"
import { shopFlow } from "./flows/shop"
import { withdrawalFlow } from "./flows/withdrawal"
import type { FlowDef, FlowId } from "./types"

export const FLOWS: Record<FlowId, FlowDef<any>> = {
  withdrawal: withdrawalFlow,
  afa: afaFlow,
  results_check: resultsCheckFlow,
  shop: shopFlow,
  sender_id: senderIdFlow,
  complaint: complaintFlow,
}
