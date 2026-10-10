/**
 * Instant campaign dispatch (spec §5.4). Orchestration over the providers; the caller
 * persists the outcome (per chunk, via onChunkSent). Never throws.
 *   sent         — accepted by the primary (Hubtel or, if not primary, Moolre) with ids, plus
 *                  Hubtel chunks with outcome "unknown" (may have been accepted: ids null)
 *   fallbackSent — platform-sender chunks Hubtel refused and Moolre accepted
 *   unconfirmed  — ids of rows placed via an "unknown" Hubtel outcome (no Hubtel ids; the
 *                  72 h DLR close refunds them if they never show delivered)
 *   everything else stays 'pending' for the cron drain.
 * Money rules: never resend or fall back on "unknown"; out_of_funds stops dispatch.
 */
import { getRoutingConfig } from "./routing"
import {
  HUBTEL_BATCH_CHUNK, hubtelConfigFromEnv, hubtelSendBatchPersonalized, hubtelSendBatchSimple,
  isValidHubtelMsisdn, toHubtelMsisdn, type HubtelSendResult,
} from "./providers/hubtel"
import { platformSenderName, sendSMSBulkViaMoolre } from "@/lib/sms-service"
import { notifyHubtelOutOfFunds } from "./notify"

export interface DispatchItem { id: string; phone: string; message: string }
export interface SentRow { id: string; mid: string | null; bid: string | null }
export interface DispatchResult {
  provider: "hubtel" | "moolre"
  sent: SentRow[]
  fallbackSent: SentRow[]
  unconfirmed: string[]
  outOfFunds: boolean
}
export type OnChunkSent = (provider: string, rows: SentRow[]) => Promise<void>

const MOOLRE_CHUNK = 100

async function moolreChunk(chunk: DispatchItem[], senderId: string | null): Promise<boolean> {
  try {
    const res = await sendSMSBulkViaMoolre(chunk.map((m) => ({ recipient: m.phone, message: m.message, ref: m.id })), senderId ?? undefined)
    return !!res.ok
  } catch {
    return false
  }
}

/** Map Hubtel's {recipient, messageId} back onto our rows (duplicate phones consume in order). */
function mapIds(chunk: DispatchItem[], res: HubtelSendResult): SentRow[] {
  const byPhone = new Map<string, string[]>()
  for (const m of res.messages) {
    const list = byPhone.get(m.recipient) ?? []
    list.push(m.messageId)
    byPhone.set(m.recipient, list)
  }
  return chunk.map((item) => ({
    id: item.id,
    mid: byPhone.get(toHubtelMsisdn(item.phone))?.shift() ?? null,
    bid: res.batchId ?? null,
  }))
}

export async function dispatchCampaign(
  items: DispatchItem[],
  senderId: string | null,
  onChunkSent?: OnChunkSent,
): Promise<DispatchResult> {
  const placed = async (provider: string, rows: SentRow[]) => {
    if (!onChunkSent || rows.length === 0) return
    try {
      await onChunkSent(provider, rows)
    } catch (e) {
      console.error(`[SMS-DISPATCH] onChunkSent (${provider}) failed:`, e)
    }
  }

  let routing: Awaited<ReturnType<typeof getRoutingConfig>>
  try {
    routing = await getRoutingConfig()
  } catch (e) {
    console.error("[SMS-DISPATCH] routing config unavailable; rows stay pending:", e)
    return { provider: "moolre", sent: [], fallbackSent: [], unconfirmed: [], outOfFunds: false }
  }
  const hubtel = hubtelConfigFromEnv()

  if (routing.primary !== "hubtel" || !hubtel) {
    const out: DispatchResult = { provider: "moolre", sent: [], fallbackSent: [], unconfirmed: [], outOfFunds: false }
    for (let i = 0; i < items.length; i += MOOLRE_CHUNK) {
      const chunk = items.slice(i, i + MOOLRE_CHUNK)
      if (await moolreChunk(chunk, senderId)) {
        const rows = chunk.map((c) => ({ id: c.id, mid: null, bid: null }))
        out.sent.push(...rows)
        await placed("moolre", rows)
      }
    }
    return out
  }

  const from = senderId ?? platformSenderName()
  const out: DispatchResult = { provider: "hubtel", sent: [], fallbackSent: [], unconfirmed: [], outOfFunds: false }
  // Hubtel can reject a whole batch over one bad number: leave unaddressable rows pending
  // (the drain's single-send path validates and fails/refunds them individually).
  const sendable = items.filter((it) => isValidHubtelMsisdn(toHubtelMsisdn(it.phone)))
  for (let i = 0; i < sendable.length; i += HUBTEL_BATCH_CHUNK) {
    const chunk = sendable.slice(i, i + HUBTEL_BATCH_CHUNK)
    const sameText = chunk.every((c) => c.message === chunk[0].message)
    let res: HubtelSendResult
    try {
      res = sameText
        ? await hubtelSendBatchSimple(hubtel, { from, recipients: chunk.map((c) => c.phone), content: chunk[0].message })
        : await hubtelSendBatchPersonalized(hubtel, { from, items: chunk.map((c) => ({ to: c.phone, content: c.message })) })
    } catch (e) {
      // Providers never throw; if one does we cannot know whether it was accepted — treat as unknown.
      console.error("[SMS-DISPATCH] Hubtel call threw; treating as unknown:", e)
      res = { outcome: "unknown", httpStatus: 0, bodyStatus: null, messages: [] }
    }

    if (res.outcome === "accepted") {
      const rows = mapIds(chunk, res)
      out.sent.push(...rows)
      await placed("hubtel", rows)
      continue
    }
    if (res.outcome === "unknown") {
      // May have been accepted: never fall back (double-send), never leave pending (drain would
      // re-send). The DLR poller's 72 h close refunds it if it never shows delivered.
      console.warn(`[SMS-DISPATCH] Hubtel unknown outcome for chunk of ${chunk.length}; treating as sent:`, res.error)
      const rows = chunk.map((c) => ({ id: c.id, mid: null, bid: null }))
      out.sent.push(...rows)
      out.unconfirmed.push(...chunk.map((c) => c.id))
      await placed("hubtel", rows)
      continue
    }
    if (res.outcome === "out_of_funds") {
      out.outOfFunds = true
      notifyHubtelOutOfFunds().catch(() => {})
      break // remaining rows stay pending; the drain retries once funded
    }
    // rejected | retryable: Hubtel definitely did not send these.
    console.warn(`[SMS-DISPATCH] Hubtel ${res.outcome} for chunk of ${chunk.length}:`, res.error)
    if (senderId === null && (await moolreChunk(chunk, null))) {
      const rows = chunk.map((c) => ({ id: c.id, mid: null, bid: null }))
      out.fallbackSent.push(...rows)
      await placed("moolre", rows)
    }
  }
  return out
}
