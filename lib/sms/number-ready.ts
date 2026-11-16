/**
 * "Your number is ready" SMS text. Pure (no I/O). HARD RULE: always ONE SMS segment, because Datagod pays for it.
 * The shop link degrades like lib/sms/shop-order-confirmation.ts: https link, bare host, no link, then the
 * generic (no shop name) copy as a last resort. The text never names the network brand, only its colour label.
 */
import { calculateSegments } from "./segments"

export interface NumberReadySmsInput {
  /** The blocked number that is now ready. */
  phone: string
  /** Already colour-mapped, e.g. "Yellow" (networkColor). */
  networkLabel: string
  shopName?: string | null
  subdomain?: string | null
  rootDomain: string
  mainUssdCode?: string | null
}

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function oneSegment(msg: string): boolean {
  return calculateSegments(msg).segments === 1
}

// GSM 03.38 basic charset (no extension table) minus control characters. Anything else, including emoji and other
// astral characters, is dropped so the message is pure GSM-7 and one segment is exactly 160 characters.
const GSM_BASIC =
  "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
const GSM_SET = new Set(Array.from(GSM_BASIC))
const SHOP_NAME_MAX = 30

export function sanitizeShopName(raw: string | null | undefined): string {
  const kept = Array.from(raw ?? "")
    .map((ch) => (/\s/.test(ch) ? " " : GSM_SET.has(ch) ? ch : ""))
    .join("")
  return kept.replace(/ +/g, " ").trim().slice(0, SHOP_NAME_MAX).trim()
}

export function buildNumberReadySms(i: NumberReadySmsInput): string {
  const shopName = sanitizeShopName(i.shopName)

  const code = (i.mainUssdCode ?? "").trim()
  const generic = code
    ? `DTGOD: ${i.phone} is now ready for ${i.networkLabel} data. Dial ${code} or visit ${i.rootDomain}`
    : `DTGOD: ${i.phone} is now ready for ${i.networkLabel} data. Visit ${i.rootDomain}`

  if (shopName) {
    const core = `DTGOD: ${i.phone} is now ready for ${i.networkLabel} data on ${shopName}.`
    const sub = (i.subdomain ?? "").trim().toLowerCase()
    if (SUBDOMAIN_RE.test(sub)) {
      const host = `${sub}.${i.rootDomain}`
      for (const link of [`https://${host}`, host]) {
        const msg = `${core} Buy again: ${link}`
        if (oneSegment(msg)) return msg
      }
    }
    if (oneSegment(core)) return core
  }

  if (oneSegment(generic)) return generic
  const bare = `DTGOD: ${i.phone} is now ready for ${i.networkLabel} data.`
  return oneSegment(bare) ? bare : `DTGOD: ${i.phone} is now ready.`
}
