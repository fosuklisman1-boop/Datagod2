import { V2_BASE_URL, type DocLang, type V2Endpoint } from "./registry"

/** POSIX single-quote a string: wrap in '...' and turn each ' into '\'' */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** PHP single-quoted string literal: only \ and ' need escaping. */
function phpQuote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

export function buildSamples(
  ep: V2Endpoint,
  opts: { baseUrl?: string; keyPlaceholder?: string } = {}
): Record<DocLang, string> {
  const base = opts.baseUrl ?? V2_BASE_URL
  const key = opts.keyPlaceholder ?? (ep.keyType === "sms" ? "dg2_sms_live_your_api_key" : "dg2_live_your_api_key")
  const url = `${base}${ep.path}`
  const hasBody = ep.method === "POST" && ep.requestExample !== null
  const json = hasBody ? JSON.stringify(ep.requestExample, null, 2) : ""

  // cURL: double quotes for plain keys, full single-quote escaping otherwise.
  const plainKey = /^[A-Za-z0-9_.:\-/ ]*$/.test(key)
  const authHeader = plainKey ? `"Authorization: ${key}"` : shellQuote(`Authorization: ${key}`)
  const curl = [`curl -X ${ep.method} ${shellQuote(url)}`, `  -H ${authHeader}`]
  if (hasBody) {
    curl.push(`  -H "Content-Type: application/json"`)
    curl.push(`  -d ${shellQuote(json)}`)
  }

  // Node.js (built-in fetch)
  const node: string[] = []
  if (hasBody) node.push(`const body = ${json}`, "")
  node.push(`const res = await fetch(${JSON.stringify(url)}, {`)
  node.push(`  method: ${JSON.stringify(ep.method)},`)
  node.push(`  headers: {`)
  node.push(`    "Authorization": ${JSON.stringify(key)},`)
  if (hasBody) node.push(`    "Content-Type": "application/json",`)
  node.push(`  },`)
  if (hasBody) node.push(`  body: JSON.stringify(body),`)
  node.push(`})`, `const data = await res.json()`, `console.log(data)`)

  // PHP (cURL extension)
  const php: string[] = ["<?php"]
  if (hasBody) php.push(`$body = ${phpQuote(json)};`, "")
  php.push(`$ch = curl_init(${phpQuote(url)});`)
  php.push(`curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);`)
  php.push(`curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpQuote(ep.method)});`)
  const phpHeaders = [`  ${phpQuote(`Authorization: ${key}`)},`]
  if (hasBody) phpHeaders.push(`  'Content-Type: application/json',`)
  php.push(`curl_setopt($ch, CURLOPT_HTTPHEADER, [`, ...phpHeaders, `]);`)
  if (hasBody) php.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, $body);`)
  php.push(`$response = curl_exec($ch);`, `curl_close($ch);`, `echo $response;`)

  // Python (requests)
  const py: string[] = ["import json", "import requests", ""]
  if (hasBody) {
    const lit = json.includes("'''") || json.includes("\\") ? JSON.stringify(json) : `r'''${json}'''`
    py.push(`payload = json.loads(${lit})`, "")
  }
  py.push(`headers = {`, `    "Authorization": ${JSON.stringify(key)},`)
  if (hasBody) py.push(`    "Content-Type": "application/json",`)
  py.push(`}`, "")
  py.push(
    hasBody
      ? `response = requests.post(${JSON.stringify(url)}, headers=headers, json=payload)`
      : `response = requests.${ep.method.toLowerCase()}(${JSON.stringify(url)}, headers=headers)`
  )
  py.push(`print(response.json())`)

  return {
    curl: curl.join(" \\\n"),
    node: node.join("\n"),
    php: php.join("\n"),
    python: py.join("\n"),
  }
}
