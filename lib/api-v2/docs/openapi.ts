import { DOC_PAGES, pageSlugForSection } from "./pages"
import { V2_BASE_URL, v2DocsRegistry, type V2DocSection, type V2Endpoint, type V2Param } from "./registry"

/**
 * OpenAPI 3.1 description of the v2 API. A pure function of the docs registry, so it can
 * never drift from the published reference. No undefined values are ever emitted.
 */

export type OpenApiDocument = Record<string, unknown>
type Json = Record<string, unknown>

const KEY_TEXT: Record<string, string> = {
  standard: "Requires a standard key.",
  commission: "Requires a commission key.",
  sms: "Requires an SMS key (it spends SMS credits, not your wallet).",
}

export function schemaForParamType(type: string): { schema: Record<string, unknown>; note?: string } {
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return { schema: { type } }
    case "array":
    case "string[]":
      return { schema: { type: "array", items: { type: "string" } } }
    default:
      return { schema: { type: "string" }, note: `Documented type: ${type}.` }
  }
}

export function inferSchema(example: unknown): Record<string, unknown> {
  if (example === null || example === undefined) return { type: "null" }
  if (Array.isArray(example)) {
    return example.length > 0 ? { type: "array", items: inferSchema(example[0]) } : { type: "array", items: {} }
  }
  switch (typeof example) {
    case "string":
      return { type: "string" }
    case "boolean":
      return { type: "boolean" }
    case "number":
      return { type: Number.isInteger(example) ? "integer" : "number" }
    case "object": {
      const entries = Object.entries(example as Json).filter(([, v]) => v !== undefined)
      return {
        type: "object",
        properties: Object.fromEntries(entries.map(([k, v]) => [k, inferSchema(v)])),
        required: entries.map(([k]) => k),
      }
    }
    default:
      return {}
  }
}

function paramSchema(p: V2Param): { schema: Json; description: string } {
  const { schema, note } = schemaForParamType(p.type)
  return { schema, description: note ? `${p.description} ${note}` : p.description }
}

function tagFor(section: V2DocSection): string {
  const slug = pageSlugForSection(section.id)
  return DOC_PAGES.find((p) => p.slug === slug)?.title ?? "API"
}

function successStatuses(ep: V2Endpoint): string[] {
  return ep.notes.some((n) => /HTTP 201/.test(n)) ? ["200", "201"] : ["200"]
}

function buildOperation(ep: V2Endpoint, section: V2DocSection): Json {
  const pathNames = [...ep.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  const parameters: Json[] = pathNames.map((name) => {
    const reg = ep.params.find((p) => p.name === name)
    const { schema, description } = reg ? paramSchema(reg) : { schema: { type: "string" }, description: name }
    return { name, in: "path", required: true, description, schema }
  })
  const rest = ep.params.filter((p) => !pathNames.includes(p.name))

  const op: Json = {
    operationId: ep.id,
    summary: ep.summary,
    tags: [tagFor(section)],
  }

  const description = [
    ep.summary,
    ...(ep.keyType ? [KEY_TEXT[ep.keyType]] : []),
    `Rate limit: ${ep.rateLimit}.`,
    ...ep.notes,
  ].join("\n\n")
  op.description = description

  if (ep.method === "GET") {
    for (const p of rest) {
      const { schema, description: d } = paramSchema(p)
      parameters.push({ name: p.name, in: "query", required: p.required, description: d, schema })
    }
  }
  if (parameters.length > 0) op.parameters = parameters

  if (ep.method === "POST" && rest.length > 0) {
    const properties: Json = {}
    for (const p of rest) {
      const { schema, description: d } = paramSchema(p)
      properties[p.name] = { ...schema, description: d }
    }
    const media: Json = {
      schema: {
        type: "object",
        properties,
        required: rest.filter((p) => p.required).map((p) => p.name),
      },
    }
    if (ep.requestExample) media.example = ep.requestExample
    op.requestBody = { required: true, content: { "application/json": media } }
  }

  if (ep.keyType) {
    op.security = [{ ApiKeyAuth: [] }, { BearerAuth: [] }, { XApiKey: [] }]
  }

  const responses: Json = {}
  const successSchema = inferSchema(ep.successExample)
  for (const status of successStatuses(ep)) {
    responses[status] = {
      description: status === "201" ? "Created." : "Success.",
      content: { "application/json": { schema: successSchema, example: ep.successExample } },
    }
  }
  const byStatus = new Map<number, string[]>()
  for (const e of ep.errors) byStatus.set(e.status, [...(byStatus.get(e.status) ?? []), e.message])
  for (const [status, messages] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    const examples: Json = {}
    messages.forEach((message, i) => {
      examples[`error_${i + 1}`] = {
        summary: message.length > 80 ? `${message.slice(0, 77)}...` : message,
        value: { success: false, error: { code: status, message } },
      }
    })
    responses[String(status)] = {
      description: `Error ${status}.`,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, examples } },
    }
  }
  op.responses = responses
  return op
}

export function buildOpenApi(registry: V2DocSection[] = v2DocsRegistry, baseUrl: string = V2_BASE_URL): OpenApiDocument {
  const paths: Record<string, Json> = {}
  for (const section of registry) {
    for (const ep of section.endpoints) {
      paths[ep.path] = { ...(paths[ep.path] ?? {}), [ep.method.toLowerCase()]: buildOperation(ep, section) }
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Datagod Developer API",
      version: "2",
      description:
        "Buy data, airtime, utility bills, Standard Bundles, results checker vouchers and AFA registrations, and send SMS, from your own software. Authenticate with an API key.",
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "The raw API key in the Authorization header (preferred).",
        },
        BearerAuth: { type: "http", scheme: "bearer", description: "Authorization: Bearer <key>." },
        XApiKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "The raw API key in X-API-Key." },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            success: { type: "boolean", const: false },
            error: {
              type: "object",
              properties: { code: { type: "integer" }, message: { type: "string" } },
              required: ["code", "message"],
            },
          },
          required: ["success", "error"],
        },
      },
    },
  }
}
