import { headers } from "next/headers"
import { isMainSiteHost } from "@/lib/seo/site"
import { getLiveFacts } from "@/lib/seo/live-facts"
import { buildLlmsTxt } from "@/lib/seo/discovery"

// Reads the request host, so this is rendered per request; the heavy part
// (live facts) is cached for an hour inside getLiveFacts().
export async function GET(): Promise<Response> {
  const host = (await headers()).get("host")
  if (!isMainSiteHost(host)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }
  return new Response(buildLlmsTxt(await getLiveFacts()), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  })
}
