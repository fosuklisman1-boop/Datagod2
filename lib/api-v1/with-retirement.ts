import type { NextRequest } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import {
  getV1RetirementConfig,
  noticeText,
  retiredBody,
  retirementHeaders,
  v1RetirementState,
} from "./retirement"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type V1Handler = (req: NextRequest, ctx?: any) => Promise<Response>

function withHeaders(res: Response, extra: Record<string, string>, body: BodyInit | null | undefined): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  if (body !== undefined) headers.delete("content-length")
  return new Response(body === undefined ? res.body : body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

/**
 * Gate for every v1 route. Unauthenticated requests reach the handler
 * untouched (it returns its own 401). Exempt users get headers only; the
 * response body is never altered for them.
 */
export function withV1Retirement(endpoint: string, handler: V1Handler): V1Handler {
  return async (req, ctx) => {
    const user = await authenticateApiKey(req)
    if (!user) return handler(req, ctx)

    const cfg = await getV1RetirementConfig()
    const { mode, sunsetAt } = v1RetirementState(cfg, user.id, new Date())
    if (mode === "normal" || !sunsetAt) return handler(req, ctx)

    const headers = retirementHeaders(sunsetAt)

    if (mode === "blocked") {
      try {
        await logApiRequest({
          userId: user.id,
          apiKeyId: user.api_key_id,
          method: req.method,
          endpoint,
          statusCode: 410,
          request: req,
        })
      } catch {
        // logging must never turn a 410 into a crash
      }
      return new Response(JSON.stringify(retiredBody(sunsetAt)), {
        status: 410,
        headers: { ...headers, "Content-Type": "application/json" },
      })
    }

    const res = await handler(req, ctx)
    if (mode === "exempt") return withHeaders(res, headers, undefined)

    // notice: add a top-level field to plain-object JSON; anything else gets headers only
    const type = res.headers.get("content-type") || ""
    if (type.includes("application/json")) {
      try {
        const text = await res.clone().text()
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return withHeaders(res, headers, JSON.stringify({ ...parsed, notice: noticeText(sunsetAt) }))
        }
      } catch {
        // fall through to headers only
      }
    }
    return withHeaders(res, headers, undefined)
  }
}
