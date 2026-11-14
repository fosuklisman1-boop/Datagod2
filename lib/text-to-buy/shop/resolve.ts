import type { ResolvedShopCode } from "../../shop-commerce/shop-code"
import { isShopCodeCandidate, shopCodeCandidates } from "./candidates"

export type ShopRef = { shopCodeId: string; shopId: string; parentShopId: string | null; name: string; helpline: string | null }

export type ShopResolution =
  | { kind: "shop"; shop: ShopRef; via: "code" | "pref" | "last" }
  | { kind: "ask" }
  | { kind: "not_found" }
  | { kind: "closed"; shop: ShopRef }

/** Every dependency is injected; the real wiring is in ./default-deps.ts. */
export type ShopResolveDeps = {
  /** Exact lookup of a shop code string (lib/shop-commerce/shop-code.ts resolveShopCode). */
  resolveShopCode: (code: string) => Promise<ResolvedShopCode | null>
  getShopPref: (sender: string) => Promise<{ shopCodeId: string } | null>
  setShopPref: (sender: string, shopCodeId: string) => Promise<void>
  lastBoughtShopCodeId: (senderLocal: string) => Promise<string | null>
  /** A remembered shop id back to its current facts: id to code string to resolveShopCode. Null when the id is gone. */
  shopCodeById: (shopCodeId: string) => Promise<ResolvedShopCode | null>
}

const toRef = (r: ResolvedShopCode): ShopRef => ({
  shopCodeId: r.shopCodeId,
  shopId: r.shopId,
  parentShopId: r.parentShopId ?? null,
  name: r.shopName,
  helpline: r.ownerPhone ?? null,
})

/** A shop that resolved: open only when its effective status is "active"; anything else is closed (never another shop). */
const settle = (r: ResolvedShopCode, via: "code" | "pref" | "last"): ShopResolution =>
  r.status === "active" ? { kind: "shop", shop: toRef(r), via } : { kind: "closed", shop: toRef(r) }

/**
 * Which shop a text is for. Order: a code in the text (the AI's nominated code last), else the sender's remembered shop,
 * else the shop they last bought from (which seeds the memory once), else ask. Codes that exist in the text but match no
 * shop are not_found and never fall back to the memory. The lane writes the pref when an order is placed; the only write
 * here is the one-time seed from the last purchase.
 */
export async function resolveShopForText(
  deps: ShopResolveDeps,
  input: { sender: string; text: string; aiCandidate?: string | null },
): Promise<ShopResolution> {
  const candidates = shopCodeCandidates(input.text)
  const ai = typeof input.aiCandidate === "string" ? input.aiCandidate.trim() : ""
  if (ai && isShopCodeCandidate(ai) && !candidates.includes(ai)) candidates.push(ai)

  if (candidates.length > 0) {
    for (const code of candidates) {
      const found = await deps.resolveShopCode(code)
      if (found) return settle(found, "code")
    }
    return { kind: "not_found" }
  }

  const pref = await deps.getShopPref(input.sender)
  if (pref) {
    const found = await deps.shopCodeById(pref.shopCodeId)
    if (found) return settle(found, "pref")
  }

  const lastId = await deps.lastBoughtShopCodeId(input.sender)
  if (lastId) {
    const found = await deps.shopCodeById(lastId)
    if (found) {
      const settled = settle(found, "last")
      if (settled.kind === "shop") await deps.setShopPref(input.sender, found.shopCodeId)
      return settled
    }
  }
  return { kind: "ask" }
}
