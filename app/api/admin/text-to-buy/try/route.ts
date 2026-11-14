import { NextRequest } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ResolvedShopCode } from "@/lib/shop-commerce/shop-code"
import { loadTtbSettings, type TtbSettings } from "@/lib/text-to-buy/settings"
import { defaultShopResolveDeps } from "@/lib/text-to-buy/shop/default-deps"
import { GIFT_RESERVE, OWN_RESERVE } from "@/lib/text-to-buy/shop/lane"
import type { ShopResolveDeps } from "@/lib/text-to-buy/shop/resolve"
import { normaliseSender } from "@/lib/text-to-buy/admin-validate"
import { processInbound } from "@/lib/text-to-buy/handle-inbound"
import { fail, gate, isResponse, json, logError, readObject, tryAllowed } from "@/lib/text-to-buy/admin-http"

// "Try it": run a pretend text through the real reader and rules and show the reply that would go out. A dry run places no
// order, sends no SMS and writes nothing. It does NOT go through acceptInbound (no row is stored). Never log the text or number.
export const dynamic = "force-dynamic"

const MAX_TEXT = 500

/** Fails loudly if a dry run ever reaches a money or write path of the shop credits (it must not). */
const forbidden = (what: string) => async (): Promise<never> => {
  throw new Error(`try-it dry run must not ${what}`)
}

/**
 * The shop line's dry run: the same reading and shop resolution as the lane, with the shop's own lookups wrapped to report
 * WHICH shop was used (name, via, status) and the credits that would be reserved (2 own number, 3 gift). The lane's dry mode
 * never sends, places, reserves, remembers a shop or writes; the credit functions are also replaced with ones that throw.
 * The payload carries names only: no phone, no helpline.
 */
async function shopDryRun(db: SupabaseClient, sender: string, text: string, settings: TtbSettings, now: Date) {
  const base = defaultShopResolveDeps(db)
  let used: { name: string; via: "code" | "pref" | "last"; status: string } | null = null
  let prefHit = false
  let gift: boolean | null = null
  const note = (r: ResolvedShopCode | null, via: "code" | "pref" | "last") => {
    if (r && !used) used = { name: r.shopName, via, status: r.status }
    return r
  }
  const resolve: ShopResolveDeps = {
    ...base,
    resolveShopCode: async (c) => note(await base.resolveShopCode(c), "code"),
    getShopPref: async (s) => {
      const p = await base.getShopPref(s)
      if (p) prefHit = true
      return p
    },
    shopCodeById: async (id) => note(await base.shopCodeById(id), prefHit ? "pref" : "last"),
    setShopPref: async () => {},
  }
  const result = await processInbound(
    db,
    crypto.randomUUID(),
    { line: "shop", from: sender, text, receivedAt: null, now },
    settings,
    {
      dryRun: true,
      onDryOffer: (o) => {
        gift = o.gift === true
      },
      shop: {
        resolve,
        credits: { accountFor: forbidden("look up an account"), reserve: forbidden("reserve") as never, release: forbidden("release") as never, capReached: forbidden("count replies") as never },
      },
    },
  )
  const shop = used as { name: string; via: string; status: string } | null
  return {
    readBy: result.readBy,
    outcome: result.outcome,
    reply: result.reply,
    shop,
    creditsToReserve: gift === null ? null : gift ? GIFT_RESERVE : OWN_RESERVE,
  }
}

export async function POST(request: NextRequest) {
  const ctx = await gate(request, true)
  if (isResponse(ctx)) return ctx
  const { db, userId } = ctx

  const body = await readObject(request)
  if (!body) return fail("invalid_body", 400)
  if (body.line !== "main" && body.line !== "shop") return fail("invalid_line", 400)
  const line = body.line
  const sender = normaliseSender(body.sender)
  if (!sender) return fail("invalid_sender", 400)
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (text.length < 1 || text.length > MAX_TEXT) return fail("invalid_text", 400)

  const now = new Date()
  if (!tryAllowed(userId as string, now.getTime())) return fail("rate_limited", 429)

  try {
    const live = await loadTtbSettings(db)
    // A dry run places nothing and writes nothing, so the admin can preview airtime and vouchers before switching them on.
    const settings = { ...live, airtimeEnabled: true, resultsCheckerEnabled: true }
    if (line === "shop") return json(await shopDryRun(db, sender, text, settings, now))
    const result = await processInbound(
      db,
      crypto.randomUUID(),
      { line: "main", from: sender, text, receivedAt: null, now },
      settings,
      { dryRun: true },
    )
    return json({ readBy: result.readBy, outcome: result.outcome, reply: result.reply })
  } catch (err) {
    logError("try", err)
    return fail("server_error", 500)
  }
}
