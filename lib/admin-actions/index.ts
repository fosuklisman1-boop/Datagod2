import type { FlowCtx } from "./contexts"
import { getDefaultDeps } from "./default-deps"
import { createNotifier } from "./notifier"
import { FLOWS } from "./registry"
import type { ChannelResult, FlowId, Outcome, Target } from "./types"

export type { Outcome, Target, ChannelResult, FlowId } from "./types"

/** Email + push to every admin. Never throws. Await it. */
export function alertAdminsOfRequest<F extends FlowId>(flow: F, ctx: FlowCtx[F]): Promise<ChannelResult[]> {
  return createNotifier(FLOWS, getDefaultDeps()).alertAdminsOfRequest(flow, ctx)
}

/** Email + SMS (+ push/in-app where the flow had them) to the user. Never throws. Await it. Call only after the state change applied. */
export function notifyUserOfOutcome<F extends FlowId>(flow: F, outcome: Outcome, target: Target, ctx: FlowCtx[F]): Promise<ChannelResult[]> {
  return createNotifier(FLOWS, getDefaultDeps()).notifyUserOfOutcome(flow, outcome, target, ctx)
}
