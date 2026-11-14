import type { SupabaseClient } from "@supabase/supabase-js"
import type { InboundResult } from "../handle-inbound"
import { priceAnswerReply, shopNameText } from "../replies"
import type { Payer } from "../send-reply"
import type { Adapters } from "../services"
import type { ShopDataDeps, ShopDataOffer } from "../services/shop-data"
import type { TtbSettings } from "../settings"
import { noticeOnce, type LastOrder, type Pending } from "../store"
import type { Outcome, ReadResult } from "../types"
import { sizeLabel } from "../catalogue"
import { classifyShopCandidates } from "./candidates"
import { releaseReserve, reserveForOrder, shopAccountFor, shopReplyCapReached } from "./credits"
import { resolveShopForText, type ShopRef, type ShopResolution, type ShopResolveDeps } from "./resolve"

/**
 * The shop line's steps in the Text-to-Buy lane. Server-only. handle-inbound.ts calls these at fixed points and only when the
 * line is "shop" (plus the main line's wrong-line notice); nothing here changes how the main line behaves.
 *
 * Who pays for a reply: once a shop has resolved AND has an SMS account, every reply of that text goes out with a shop payer
 * (one credit, drawn from the order's reserve when it has one). Pre-resolution replies (Which shop?, shop not found, the
 * wrong-line notice) and the closed / paused notices are always Datagod-paid (say(..., { datagod: true })). A shop-paid
 * reply that cannot be charged is simply not sent: there is no Datagod fallback anywhere in this file.
 */

/** Candidate tokens tried against the shop table per text. Strong candidates go first, so the cap drops weak ones. */
export const MAX_SHOP_CANDIDATES = 5

const ASK_REPLY = "Which shop? Reply with the shop code"
const NOT_FOUND_REPLY = "Shop not found. Check the code and try again."
/** Credits set aside before an order is placed (exported so the admin try-it reports the same numbers). */
export const OWN_RESERVE = 2
export const GIFT_RESERVE = 3

export type ShopCredits = {
  accountFor: (db: SupabaseClient, shopId: string) => Promise<{ accountId: string } | null>
  reserve: typeof reserveForOrder
  release: typeof releaseReserve
  capReached: typeof shopReplyCapReached
}
export type ShopLaneDeps = {
  /** Shop lookups and memory (the real ones: ./default-deps.ts). */
  resolve?: ShopResolveDeps
  /** The shop data adapter's collaborators (shop prices, shop confirm). */
  shopData?: ShopDataDeps
  credits?: Partial<ShopCredits>
}

const DEFAULT_CREDITS: ShopCredits = { accountFor: shopAccountFor, reserve: reserveForOrder, release: releaseReserve, capReached: shopReplyCapReached }

export type Say = (outcome: Outcome, text: string | null, extra?: { datagod?: boolean; transactional?: boolean }) => Promise<InboundResult>
type Held = { done: InboundResult } | { read: ReadResult } | null

export type LaneEnv = {
  db: SupabaseClient
  messageId: string
  sender: string
  text: string
  now: Date
  dry: boolean
  settings: TtbSettings
  deps: ShopLaneDeps
  alert: (message: string) => Promise<void>
  say: Say
  /** Saves the turn and the given pending (handle-inbound's own remember). */
  remember: (text: string, assistant: string, patch: { pending?: Pending | null }) => Promise<void>
  /** The shop adapter set for this resolved shop. */
  buildAdapters: (shop: ShopRef) => Adapters
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** "<SHOP> can't take text orders right now. Call <helpline>." The helpline part only when the shop has a usable number. */
export function closedReply(shop: ShopRef): string {
  const call = shop.helpline && /^\d{9,15}$/.test(shop.helpline) ? ` Call ${shop.helpline}.` : ""
  return `${shopNameText(shop.name, 30)} can't take text orders right now.${call}`
}

export const wrongLineReply = (shopNumber: string) => `For shop orders text ${shopNumber}`

/** The size or amount text the read already used: a 4 or 6 digit one of these is not a shop code attempt. */
export function excludeTokensFor(read: ReadResult): string[] {
  if ((read.kind === "order" && read.service === "data") || (read.kind === "price_query" && read.sizeMb !== null)) {
    const mb = (read as { sizeMb: number }).sizeMb
    return [String(mb), String(mb / 1000)]
  }
  return []
}

/** Counts every code lookup of one text and answers null once the cap is spent (no lookup is made). */
function cappedLookups(deps: ShopResolveDeps): ShopResolveDeps {
  let tried = 0
  return {
    ...deps,
    resolveShopCode: async (code) => {
      if (tried >= MAX_SHOP_CANDIDATES) return null
      tried += 1
      return deps.resolveShopCode(code)
    },
  }
}

export type ShopLane = ReturnType<typeof makeShopLane>

export function makeShopLane(env: LaneEnv) {
  const credits: ShopCredits = { ...DEFAULT_CREDITS, ...env.deps.credits }
  let resolveDeps: ShopResolveDeps | null = env.deps.resolve ?? null
  const lookups = async (): Promise<ShopResolveDeps> => {
    if (!resolveDeps) resolveDeps = (await import("./default-deps")).defaultShopResolveDeps(env.db)
    // A try-it never writes: the resolver's own seeding of the memory is switched off too.
    const d = env.dry ? { ...resolveDeps, setShopPref: async () => {} } : resolveDeps
    return cappedLookups(d)
  }

  let shop: ShopRef | null = null
  let accountId: string | null = null
  let reserved = false
  let seq = 0

  const closed = async (s: ShopRef): Promise<InboundResult> => {
    const text = closedReply(s)
    if (env.dry) return env.say("unavailable", text, { datagod: true })
    const first = await noticeOnce(env.db, "closed", env.sender, s.shopId, dayOf(env.now))
    return env.say("unavailable", first ? text : null, { datagod: true })
  }

  /** The pause path: no order, no prompt; the once-a-day Datagod-paid reply, and (for a shop-side cause) one throttled owner alert. */
  const pause = async (s: ShopRef, alertOwner: boolean): Promise<InboundResult> => {
    const text = closedReply(s)
    if (env.dry) return env.say("unavailable", text, { datagod: true })
    const day = dayOf(env.now)
    if (alertOwner && (await noticeOnce(env.db, "paused_alert", "shop", s.shopId, day))) {
      try {
        // No shop-owner notification channel exists in this lane yet, so the existing Text-to-Buy admin alert carries it.
        await env.alert(`Text-to-Buy: a shop's text orders are paused (no SMS credits or account): shop ${s.shopId}`)
      } catch {
        // an alert must never throw out of the lane
      }
    }
    const first = await noticeOnce(env.db, "paused", env.sender, s.shopId, day)
    return env.say("unavailable", first ? text : null, { datagod: true })
  }

  const rememberShop = async (s: ShopRef) => {
    if (env.dry || !resolveDeps) return
    try {
      await resolveDeps.setShopPref(env.sender, s.shopCodeId)
    } catch {
      // the memory is a convenience: never break the order for it
    }
  }

  /** A resolved, open shop: its SMS account, then the per-shop reply cap. Null = go on; else the result to return. */
  const enter = async (s: ShopRef, via: "code" | "pref" | "last"): Promise<InboundResult | null> => {
    shop = s
    if (via === "code") await rememberShop(s)
    if (env.dry) return null
    const acct = await credits.accountFor(env.db, s.shopId).catch(() => null)
    if (!acct) {
      shop = null
      return pause(s, true)
    }
    if (await credits.capReached(env.db, s.shopId, env.settings, env.now)) {
      shop = null
      return env.say("limited", null, { datagod: true })
    }
    accountId = acct.accountId
    return null
  }

  /** What a resolution that did not find an open shop means for the customer. Null when it is an open shop. */
  const refuse = async (r: ShopResolution, read: ReadResult): Promise<InboundResult | null> => {
    if (r.kind === "ask") {
      await env.remember(env.text, ASK_REPLY, { pending: { type: "shop", read } })
      return env.say("asked", ASK_REPLY, { datagod: true })
    }
    if (r.kind === "not_found") return env.say("unavailable", NOT_FOUND_REPLY, { datagod: true })
    if (r.kind === "closed") return closed(r.shop)
    return null
  }

  return {
    get shopId(): string {
      return (shop as ShopRef).shopId
    },

    /** True once replies of this text are shop-paid (a shop resolved and has an account). */
    paysReplies: (): boolean => shop !== null && accountId !== null && !env.dry,

    /** The shop payer for the next reply. Each call mints a new replyKey. */
    payer(): Payer {
      seq += 1
      return {
        kind: "shop",
        shopId: (shop as ShopRef).shopId,
        accountId: accountId as string,
        messageId: reserved ? env.messageId : null,
        replyKey: `${env.messageId}-${seq}`,
      }
    },

    capReached: (): Promise<boolean> => credits.capReached(env.db, (shop as ShopRef).shopId, env.settings, env.now),

    /** The shop adapter set (call after a shop has resolved). */
    adapters: (): Adapters => env.buildAdapters(shop as ShopRef),

    /**
     * The customer answers "Which shop?": a shop code in this text completes the held read. A text with no code in it is not an
     * answer (null: it is read as a new text). An unknown or closed shop answers right away.
     */
    async held(pending: Pending | null): Promise<Held> {
      if (pending?.type !== "shop") return null
      const r = await resolveShopForText(await lookups(), { sender: env.sender, text: env.text, expectingCode: true })
      if (r.kind === "shop") {
        if (r.via !== "code") return null
        const stop = await enter(r.shop, r.via)
        return stop ? { done: stop } : { read: pending.read }
      }
      if (r.kind === "not_found" || r.kind === "closed") return { done: (await refuse(r, pending.read)) as InboundResult }
      return null
    },

    /**
     * Resolves the shop for this read (a code in the text, else the remembered shop, else the last purchase, else asks).
     * retry: AGAIN / YES re-resolve the shop stored with the last order, never another one. Null = shop ready; else the result.
     */
    async ensureShop(read: ReadResult, retry: { shopCodeId: string | null } | null): Promise<InboundResult | null> {
      if (shop) return null
      const deps = await lookups()
      const r = retry
        ? await resolveShopForText(
            { ...deps, getShopPref: async () => (retry.shopCodeId ? { shopCodeId: retry.shopCodeId } : null), lastBoughtShopCodeId: async () => null },
            { sender: env.sender, text: "" },
          )
        : await resolveShopForText(deps, { sender: env.sender, text: env.text, excludeTokens: excludeTokensFor(read) })
      if (r.kind === "shop") return enter(r.shop, r.via)
      return refuse(r, read)
    },

    /** The price answer for "how much is 5GB?": the shop's own verified price. */
    priceAnswer: (offer: unknown): string => {
      const o = offer as ShopDataOffer
      return priceAnswerReply(sizeLabel(o.size), o.networkLabel, o.price)
    },

    /**
     * Immediately before the order is placed: the shop must still be open (re-read now, fail closed), then the reserve
     * (2 credits, 3 for a gift). Null = go on and place; else the result to return (nothing was placed or reserved).
     */
    async beforePlace(offer: { gift: boolean }): Promise<InboundResult | null> {
      const s = shop as ShopRef
      let open = false
      try {
        const now = await (await lookups()).shopCodeById(s.shopCodeId)
        open = !!now && now.status === "active"
      } catch {
        open = false
      }
      if (!open) return closed(s)
      try {
        const r = await credits.reserve(env.db, { accountId: accountId as string, shopId: s.shopId, messageId: env.messageId, credits: offer.gift ? GIFT_RESERVE : OWN_RESERVE })
        if (!r.ok) return pause(s, true)
      } catch {
        return pause(s, false)
      }
      reserved = true
      return null
    },

    /**
     * Gives the reserve back when nothing was placed. A failed release is left for the sweep (the release is keyed by the
     * message id and idempotent); it never throws and logs one fixed line.
     */
    async release(): Promise<void> {
      if (!reserved) return
      reserved = false
      try {
        await credits.release(env.db, env.messageId)
      } catch {
        console.error("[text-to-buy] shop reserve release failed", { messageId: env.messageId })
      }
    },

    /** The stored last order of a shop order names its shop, so AGAIN / YES re-resolve the same one. */
    lastOrder(lo: LastOrder): LastOrder {
      return "service" in lo || !shop ? lo : { ...lo, shopCodeId: (shop as ShopRef).shopCodeId }
    },

    /** After a placed and linked order: the shop is the sender's remembered one. */
    afterOrder: () => (shop ? rememberShop(shop) : Promise.resolve()),
  }
}

export type MainWrongLineEnv = { db: SupabaseClient; sender: string; text: string; now: Date; settings: TtbSettings; deps: ShopLaneDeps }

/**
 * Main line only, for a text the lane could not read as an order: a strong shop-code candidate that resolves to an ACTIVE shop
 * means the customer texted the wrong number. Returns the reply (first time today for this sender), "silent" (already told today),
 * or null (nothing to say: no shop number set, no such code, or a shop that is not active). Looks at most MAX_SHOP_CANDIDATES.
 */
export async function mainWrongLine(env: MainWrongLineEnv): Promise<{ reply: string } | "silent" | null> {
  const shopNumber = env.settings.shopNumber.trim()
  if (!shopNumber) return null
  const strong = classifyShopCandidates(env.text).filter((c) => c.strong).slice(0, MAX_SHOP_CANDIDATES)
  if (strong.length === 0) return null
  const deps = env.deps.resolve ?? (await import("./default-deps")).defaultShopResolveDeps(env.db)
  for (const c of strong) {
    const found = await deps.resolveShopCode(c.token)
    if (!found) continue
    if (found.status !== "active") return null
    return (await noticeOnce(env.db, "wrong_line", env.sender, null, dayOf(env.now))) ? { reply: wrongLineReply(shopNumber) } : "silent"
  }
  return null
}
