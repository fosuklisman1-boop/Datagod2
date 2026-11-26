// Release 6 webhook SSRF guard. A developer-supplied URL is checked twice: its syntax when saved and at every send, and
// every address its host resolves to at every send (any private/reserved address refuses the lot). The connection is
// then pinned to the vetted address with pinnedLookup, so DNS cannot change between the check and the connect.
import { isIP } from "net"

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; error: string }

const BAD_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".arpa", ".intranet", ".corp"]

export function checkUrlSyntax(raw: string): UrlCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Enter a valid URL." }
  const s = raw.trim()
  if (s.length > 500) return { ok: false, error: "The URL must be at most 500 characters." }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, error: "Enter a valid URL." }
  }
  if (u.protocol !== "https:") return { ok: false, error: "The URL must start with https://." }
  if (u.username || u.password) return { ok: false, error: "Remove the credentials from the URL." }
  if (u.port && u.port !== "443") return { ok: false, error: "Only the standard HTTPS port (443) is allowed." }
  if (s.includes("#")) return { ok: false, error: "Remove the #fragment from the URL." }
  const host = u.hostname.toLowerCase().replace(/\.$/, "")
  if (isIP(host.replace(/^\[|\]$/g, ""))) return { ok: false, error: "Use a host name, not an IP address." }
  if (host === "localhost" || !host.includes(".") || BAD_SUFFIXES.some((x) => host.endsWith(x))) {
    return { ok: false, error: "That host name is not allowed. Use a public host name." }
  }
  return { ok: true, url: u.href, host }
}

// ---------- address ranges ----------

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]

function v4ToInt(ip: string): number | null {
  const p = ip.split(".")
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null
  return p.reduce((a, x) => a * 256 + Number(x), 0)
}
const V4_RANGES = V4_BLOCKS.map(([b, bits]) => ({ base: v4ToInt(b)!, size: 2 ** (32 - bits) }))
const blockedV4Int = (n: number) => V4_RANGES.some((r) => n >= r.base && n < r.base + r.size)

/** 16 bytes, or null when not a valid IPv6 literal (an embedded dotted IPv4 tail is allowed). */
function v6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase()
  if (s.includes("%")) s = s.slice(0, s.indexOf("%")) // zone id
  let tail: number[] = []
  const dot = s.lastIndexOf(":")
  if (s.slice(dot + 1).includes(".")) {
    const n = v4ToInt(s.slice(dot + 1))
    if (n === null) return null
    tail = [(n >>> 16) & 0xffff, n & 0xffff]
    s = s.slice(0, dot + 1) + "0:0"
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const part = (h: string) => (h === "" ? [] : h.split(":"))
  const head = part(halves[0])
  const rest = halves.length === 2 ? part(halves[1]) : []
  const fill = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  const words = groups.map((g) => parseInt(g, 16))
  if (tail.length) words.splice(6, 2, ...tail)
  return words.flatMap((w) => [w >> 8, w & 0xff])
}

function blockedV6(b: number[]): boolean {
  const v4At = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4Int(v4At(12)) // ::ffff:a.b.c.d
  if (zero(0, 12)) return true // ::, ::1, ::a.b.c.d (deprecated compatible)
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return true // ::ffff:0:0/96 SIIT
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) return true // 64:ff9b:1::/48 local NAT64
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true // fec0::/10 deprecated site-local
  if (b[0] === 0x3f && (b[1] & 0xf0) === 0xf0) return true // 3fff::/20 documentation
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return blockedV4Int(v4At(12)) // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4Int(v4At(2)) // 6to4
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xff) return true // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true // documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true // Teredo
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true // 100::/64 discard
  return false
}

/** True for anything we must never connect to, including anything that is not a valid IP literal. */
export function isBlockedAddress(ip: string): boolean {
  if (typeof ip !== "string" || !ip) return true
  const fam = isIP(ip)
  if (fam === 4) {
    const n = v4ToInt(ip)
    return n === null || blockedV4Int(n)
  }
  if (fam === 6) {
    const b = v6Bytes(ip)
    return b === null || blockedV6(b)
  }
  return true
}

export type Resolved = { ok: true; address: string; family: number } | { ok: false; error: string }
export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>

/** A stalling DNS server gives up after timeoutMs (the send timer only starts once an address is vetted). */
export async function resolveSafe(host: string, lookupAll: LookupAll, timeoutMs = 3000): Promise<Resolved> {
  let addrs: { address: string; family: number }[]
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    addrs = await Promise.race([
      lookupAll(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns timeout")), timeoutMs)
      }),
    ])
  } catch {
    return { ok: false, error: "DNS lookup failed for the webhook host." }
  } finally {
    clearTimeout(timer)
  }
  if (!Array.isArray(addrs) || addrs.length === 0) return { ok: false, error: "DNS lookup failed for the webhook host." }
  if (addrs.some((a) => isBlockedAddress(a?.address))) return { ok: false, error: "The webhook host resolves to a private or reserved address." }
  return { ok: true, address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 }
}

type LookupCb = (...args: unknown[]) => void
/** A net/https `lookup` that always answers the vetted address (both the single and the `all: true` shapes). */
export function pinnedLookup(address: string, family: number) {
  return (_host: string, options: unknown, cb?: LookupCb) => {
    const callback = (typeof options === "function" ? options : cb) as LookupCb
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true
    if (all) callback(null, [{ address, family }])
    else callback(null, address, family)
  }
}
