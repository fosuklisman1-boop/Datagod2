import { buildOpenApi } from "./openapi"
import { buildApiMarkdown } from "./api-markdown"

const CACHE = "public, max-age=300"

export function openApiResponse(): Response {
  return new Response(JSON.stringify(buildOpenApi(), null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "inline",
      "Cache-Control": CACHE,
    },
  })
}

export function markdownResponse(): Response {
  return new Response(buildApiMarkdown(), {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": "inline",
      "Cache-Control": CACHE,
    },
  })
}
