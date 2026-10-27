import { V2_BASE_URL, type V2DocSection, type V2Endpoint } from "./registry"

/**
 * Postman Collection v2.1.0 and environment generators. Pure functions of the docs registry,
 * so the downloadable collection can never drift from the published reference.
 * Keys are placeholders only; users paste their own into the environment.
 */

const SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"

const KEY_VARS = ["standard_key", "commission_key", "sms_key"] as const

const PATH_PARAM_SAMPLES: Record<string, string> = {
  reference: "ord_123",
  campaign_id: "00000000-0000-4000-8000-000000000000",
}

const sampleFor = (name: string) => PATH_PARAM_SAMPLES[name] ?? `your_${name}`

function describe(ep: V2Endpoint): string {
  const lines: string[] = [ep.summary, "", `Key type: ${ep.keyType ?? "none"}. Rate limit: ${ep.rateLimit}.`]
  if (ep.params.length > 0) {
    lines.push("", "| Parameter | Type | Required | Description |", "| --- | --- | --- | --- |")
    for (const p of ep.params) {
      lines.push(`| ${p.name} | ${p.type} | ${p.required ? "yes" : "no"} | ${p.description.replace(/\|/g, "\\|")} |`)
    }
  }
  if (ep.errors.length > 0) {
    lines.push("", "Errors:")
    for (const e of ep.errors) lines.push(`- ${e.status}: ${e.message}`)
  }
  return lines.join("\n")
}

const TEST_SCRIPT = [
  'pm.test("Response is the Datagod JSON envelope", function () {',
  "  const json = pm.response.json();",
  '  pm.expect(json).to.have.property("success");',
  '  pm.expect(json.success).to.be.a("boolean");',
  "});",
]

function buildRequest(ep: V2Endpoint) {
  const colonPath = ep.path.replace(/\{(\w+)\}/g, ":$1")
  const params = [...ep.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  const header: { key: string; value: string; type: "text" }[] = []
  if (ep.keyType) header.push({ key: "Authorization", value: `{{${ep.keyType}_key}}`, type: "text" })

  const request: Record<string, unknown> = {
    method: ep.method,
    header,
    url: {
      raw: `{{base_url}}${colonPath}`,
      host: ["{{base_url}}"],
      path: colonPath.replace(/^\//, "").split("/"),
      ...(params.length > 0 ? { variable: params.map((key) => ({ key, value: sampleFor(key) })) } : {}),
    },
    description: describe(ep),
  }

  if (ep.method === "POST" && ep.requestExample !== null) {
    header.push({ key: "Content-Type", value: "application/json", type: "text" })
    request.body = {
      mode: "raw",
      raw: JSON.stringify(ep.requestExample, null, 2),
      options: { raw: { language: "json" } },
    }
  }

  return {
    name: `${ep.method} ${ep.path}`,
    request,
    event: [{ listen: "test", script: { type: "text/javascript", exec: TEST_SCRIPT } }],
  }
}

export function buildPostmanCollection(sections: V2DocSection[], baseUrl: string = V2_BASE_URL) {
  return {
    info: {
      name: "Datagod Developer API v2",
      description:
        "Datagod Developer API v2. Import the matching environment (Sandbox or Live), paste your API keys into it, and select it before sending requests. Generated from the live API reference.",
      schema: SCHEMA,
    },
    variable: [
      { key: "base_url", value: baseUrl },
      ...KEY_VARS.map((key) => ({ key, value: "" })),
    ],
    item: sections
      .filter((s) => s.endpoints.length > 0)
      .map((s) => ({ name: s.label, item: s.endpoints.map(buildRequest) })),
  }
}

export function buildPostmanEnvironment(kind: "sandbox" | "live") {
  const mode = kind === "sandbox" ? "test" : "live"
  const values = [
    { key: "base_url", value: V2_BASE_URL },
    { key: "standard_key", value: `dg2_${mode}_your_api_key` },
    { key: "commission_key", value: `dg2_cs_${mode}_your_api_key` },
    { key: "sms_key", value: `dg2_sms_${mode}_your_api_key` },
  ].map((v) => ({ ...v, type: v.key === "base_url" ? "default" : "secret", enabled: true }))
  return {
    id: `datagod-v2-${kind}`,
    name: kind === "sandbox" ? "Datagod v2 Sandbox" : "Datagod v2 Live",
    values,
    _postman_variable_scope: "environment",
  }
}
