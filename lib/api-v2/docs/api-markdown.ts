import { V2_BASE_URL, v2DocsRegistry, type V2DocSection, type V2Endpoint } from "./registry"

/** The whole v2 API as one Markdown document. A pure function of the docs registry. */

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")

function renderEndpoint(ep: V2Endpoint): string[] {
  const out: string[] = [`### ${ep.method} ${ep.path}`, "", ep.summary, ""]
  out.push(`- Key type: ${ep.keyType ?? "none"}`, `- Rate limit: ${ep.rateLimit}`, "")
  if (ep.params.length > 0) {
    out.push("| Parameter | Type | Required | Description |", "| --- | --- | --- | --- |")
    for (const p of ep.params) out.push(`| ${p.name} | ${cell(p.type)} | ${p.required ? "yes" : "no"} | ${cell(p.description)} |`)
    out.push("")
  }
  if (ep.requestExample) out.push("Request example:", "", "```json", JSON.stringify(ep.requestExample, null, 2), "```", "")
  out.push("Response example:", "", "```json", JSON.stringify(ep.successExample, null, 2), "```", "")
  if (ep.errors.length > 0) {
    out.push("Errors:", "")
    for (const e of ep.errors) out.push(`- ${e.status}: ${e.message}`)
    out.push("")
  }
  if (ep.notes.length > 0) {
    out.push("Notes:", "")
    for (const n of ep.notes) out.push(`- ${n}`)
    out.push("")
  }
  return out
}

function renderSection(s: V2DocSection): string[] {
  const out: string[] = [`## ${s.label}`, ""]
  if (s.intro) out.push(s.intro, "")
  if (s.steps && s.steps.length > 0) {
    s.steps.forEach((step, i) => out.push(`${i + 1}. ${step}`))
    out.push("")
  }
  for (const c of s.callouts ?? []) {
    out.push(`> **${c.title ?? (c.tone === "warning" ? "Warning" : "Note")}**: ${c.body}`, "")
  }
  for (const ep of s.endpoints) out.push(...renderEndpoint(ep))
  return out
}

export function buildApiMarkdown(registry: V2DocSection[] = v2DocsRegistry, baseUrl: string = V2_BASE_URL): string {
  const lines: string[] = [
    "# Datagod Developer API (v2)",
    "",
    `Base URL: ${baseUrl}`,
    "",
    "Authenticate every request with your API key (Authorization header, Authorization: Bearer, or X-API-Key). Responses are JSON.",
    "",
  ]
  for (const s of registry) lines.push(...renderSection(s))
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"
}
