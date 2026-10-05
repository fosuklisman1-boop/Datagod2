import crypto from "crypto"
import type { HubtelFieldType, HubtelPlatform, HubtelReply, HubtelRequest, HubtelRequestType } from "./types"

export const USSD_SCREEN_LIMIT = 182
export const HUBTEL_FULFILLMENT_IPS = ["52.50.116.54", "18.202.122.131", "52.31.15.68"] as const

/** Printable ASCII + \n only. Hubtel rejects special characters (UUE error). */
export function sanitizeMessage(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E\n]/g, "")
}

export function fitMessage(text: string, platform: HubtelPlatform): string {
  const clean = sanitizeMessage(text)
  if (platform !== "USSD" || clean.length <= USSD_SCREEN_LIMIT) return clean
  return clean.slice(0, USSD_SCREEN_LIMIT - 3) + "..."
}

export function respond(
  sessionId: string,
  message: string,
  opts: { label?: string; fieldType?: HubtelFieldType; clientState?: string; platform?: HubtelPlatform } = {}
): HubtelReply {
  return {
    SessionId: sessionId,
    Type: "response",
    Message: fitMessage(message, opts.platform ?? "USSD"),
    Label: opts.label ?? "Menu",
    DataType: "input",
    FieldType: opts.fieldType ?? "number",
    ClientState: opts.clientState ?? "",
  }
}

export function release(
  sessionId: string,
  message: string,
  opts: { label?: string; platform?: HubtelPlatform } = {}
): HubtelReply {
  return {
    SessionId: sessionId,
    Type: "release",
    Message: fitMessage(message, opts.platform ?? "USSD"),
    Label: opts.label ?? "Done",
    DataType: "display",
    FieldType: "text",
  }
}

export function addToCart(
  sessionId: string,
  args: { itemName: string; price: number; message: string; platform?: HubtelPlatform }
): HubtelReply {
  const message = fitMessage(args.message, args.platform ?? "USSD")
  return {
    SessionId: sessionId,
    Type: "AddToCart",
    Message: message,
    Label: message,
    DataType: "display",
    FieldType: "text",
    Item: {
      ItemName: sanitizeMessage(args.itemName),
      Qty: 1,
      Price: Math.round(args.price * 100) / 100,
    },
  }
}

export function parseHubtelRequest(body: unknown): HubtelRequest | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  const rawType = typeof b.Type === "string" ? b.Type.toLowerCase() : ""
  const type: HubtelRequestType | null =
    rawType === "initiation" ? "Initiation" : rawType === "response" ? "Response" : rawType === "timeout" ? "Timeout" : null
  if (!type) return null
  if (typeof b.SessionId !== "string" || !b.SessionId) return null
  if (typeof b.Mobile !== "string" || !b.Mobile) return null
  const platform: HubtelPlatform = b.Platform === "Webstore" || b.Platform === "Hubtel-App" ? b.Platform : "USSD"
  return {
    Type: type,
    Mobile: b.Mobile,
    SessionId: b.SessionId,
    ServiceCode: String(b.ServiceCode ?? ""),
    Message: typeof b.Message === "string" ? b.Message : "",
    Operator: String(b.Operator ?? ""),
    Sequence: Number(b.Sequence ?? 0) || 0,
    ClientState: typeof b.ClientState === "string" ? b.ClientState : "",
    Platform: platform,
  }
}

export function toLocalPhone(mobile: string): string {
  const m = mobile.trim().replace(/\s+/g, "")
  if (m.startsWith("+233")) return "0" + m.slice(4)
  if (m.startsWith("233")) return "0" + m.slice(3)
  return m
}

export function toE164(mobile: string): string {
  const local = toLocalPhone(mobile)
  return local.startsWith("0") ? "+233" + local.slice(1) : mobile
}

export function secretsMatch(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function getClientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for")
  if (!xff) return null
  return xff.split(",")[0].trim() || null
}

export function isHubtelFulfillmentIp(ip: string | null): boolean {
  return !!ip && (HUBTEL_FULFILLMENT_IPS as readonly string[]).includes(ip)
}
