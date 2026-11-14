import type { ResolvedShopCode } from "../../shop-commerce/shop-code"
import { classifyShopCandidates, isShopCodeCandidate, isStrongToken, type ShopCandidate } from "./candidates"

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

export type ShopResolveInput = {
  sender: string
  text: string
  aiCandidate?: string | null
  /** Size and amount token text the order read already used (a 4 or 6 digit one of these is not a code attempt). */
  excludeTokens?: string[]
  /** True when the customer is answering the "Which shop?" question: every candidate is a real attempt. */
  expectingCode?: boolean
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
 * Which shop a text is for. A code in the text (strong candidates first, then weak, the AI's nominated code last) wins.
 * A strong candidate that matches no shop is not_found and never falls back to the memory; weak ones (a stray word, a
 * name) that match nothing are ignored. Then the remembered shop: once a pref row exists its result is final (shop,
 * closed, or ask when it no longer resolves) and the last purchase is never consulted. Only with no pref row does the
 * last purchase apply, seeding the pref once. Else ask. The lane writes the pref when an order is placed.
 */
export async function resolveShopForText(deps: ShopResolveDeps, input: ShopResolveInput): Promise<ShopResolution> {
  const all = classifyShopCandidates(input.text, { excludeTokens: input.excludeTokens, expectingCode: input.expectingCode })
  const strongs = all.filter((c) => c.strong)
  const weaks = all.filter((c) => !c.strong)
  const ordered: ShopCandidate[] = [...strongs, ...weaks]

  const ai = typeof input.aiCandidate === "string" ? input.aiCandidate.trim() : ""
  if (ai && isShopCodeCandidate(ai) && input.text.toLowerCase().includes(ai.toLowerCase()) && !ordered.some((c) => c.token === ai)) {
    ordered.push({ token: ai, strong: input.expectingCode === true || isStrongToken(ai, input.excludeTokens) })
  }

  for (const c of ordered) {
    const found = await deps.resolveShopCode(c.token)
    if (found) return settle(found, "code")
  }
  if (ordered.some((c) => c.strong)) return { kind: "not_found" }

  const pref = await deps.getShopPref(input.sender)
  if (pref) {
    const found = await deps.shopCodeById(pref.shopCodeId).catch(() => null)
    return found ? settle(found, "pref") : { kind: "ask" }
  }

  const lastId = await deps.lastBoughtShopCodeId(input.sender)
  if (lastId) {
    const found = await deps.shopCodeById(lastId).catch(() => null)
    if (found) {
      const settled = settle(found, "last")
      if (settled.kind === "shop") await deps.setShopPref(input.sender, found.shopCodeId).catch(() => {})
      return settled
    }
  }
  return { kind: "ask" }
}
