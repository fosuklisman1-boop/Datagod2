"use client"

import { useState } from "react"
import Link from "next/link"
import { Check, Copy, Play } from "lucide-react"
import { cn } from "@/lib/utils"
import type { V2Endpoint } from "@/lib/api-v2/docs/registry"
import { buildTryItRequest, checkTestKey, pathParamNames, runTryIt, type TryItResult } from "@/lib/api-v2/docs/try-it"
import { statusCls } from "./EndpointBlock"

const REFUSAL: Record<"empty" | "live" | "invalid", string> = {
  empty: "Paste a test key first.",
  live: "That is a live key. Try it accepts test keys only; live keys never go in a browser.",
  invalid: "That does not look like a test key. Test keys start with dg2_test_, dg2_cs_test_ or dg2_sms_test_.",
}

const FIELD =
  "w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"

const KIND_LABEL: Record<TryItResult["kind"], string> = {
  json: "JSON response",
  text: "Not JSON, shown as plain text",
  empty: "Empty response body",
  "network-error": "Network error",
}

/** Try-it console. The key lives only in this component's state: never stored, logged or put in a URL. */
export function TryIt({ endpoint: ep }: { endpoint: V2Endpoint }) {
  const paramNames = pathParamNames(ep.path)
  const hasBody = ep.method === "POST" && ep.requestExample !== null
  const [key, setKey] = useState("")
  const [pathParams, setPathParams] = useState<Record<string, string>>({})
  const [body, setBody] = useState(hasBody ? JSON.stringify(ep.requestExample, null, 2) : "")
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TryItResult | null>(null)
  const [copied, setCopied] = useState(false)
  const id = `tryit-${ep.id}`

  async function send() {
    setResult(null)
    const check = checkTestKey(key)
    if (!check.ok) {
      setKey("")
      setMessage(REFUSAL[check.reason])
      return
    }
    const req = buildTryItRequest(ep, { key: check.key, pathParams, body })
    if (!req.ok) {
      setMessage(req.error)
      return
    }
    setMessage(null)
    setBusy(true)
    try {
      setResult(await runTryIt(req))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.display)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-primary/25 bg-primary/[0.04] p-4" aria-label={`Try ${ep.method} ${ep.path}`}>
      <h4 className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">Try it</h4>
      <p className="text-xs leading-5 text-muted-foreground">
        Test keys only. The call goes to this site&apos;s sandbox, counts against your key&apos;s rate limits and appears in your logs. Your key
        stays in this page and is never saved.{" "}
        <Link href="/developers/go-live" className="font-semibold text-primary underline-offset-4 hover:underline">
          Moving to live keys
        </Link>
      </p>

      <div className="space-y-1.5">
        <label htmlFor={`${id}-key`} className="text-xs font-semibold text-foreground">
          Test API key
        </label>
        <input
          id={`${id}-key`}
          type="password"
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="dg2_test_..."
          className={FIELD}
        />
      </div>

      {paramNames.map((name) => (
        <div key={name} className="space-y-1.5">
          <label htmlFor={`${id}-p-${name}`} className="text-xs font-semibold text-foreground">
            Path parameter <span className="font-mono">{name}</span>
          </label>
          <input
            id={`${id}-p-${name}`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={pathParams[name] ?? ""}
            onChange={(e) => setPathParams((p) => ({ ...p, [name]: e.target.value }))}
            className={FIELD}
          />
        </div>
      ))}

      {hasBody && (
        <div className="space-y-1.5">
          <label htmlFor={`${id}-body`} className="text-xs font-semibold text-foreground">
            Request body (JSON)
          </label>
          <textarea
            id={`${id}-body`}
            rows={Math.min(14, body.split("\n").length + 1)}
            spellCheck={false}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className={cn(FIELD, "resize-y")}
          />
        </div>
      )}

      <button
        type="button"
        onClick={send}
        disabled={busy}
        className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        <Play className="size-4" aria-hidden />
        {busy ? "Sending..." : "Send"}
      </button>

      {message && (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700">
          {message}
        </p>
      )}

      {result && (
        <div className="space-y-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {result.status !== null && (
              <span className={cn("rounded-md border px-1.5 py-0.5 font-mono font-bold", result.status < 400 ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" : statusCls(result.status))}>
                {result.status}
              </span>
            )}
            <span className="text-muted-foreground">{result.elapsedMs} ms</span>
            <span className="font-semibold text-foreground/80">{KIND_LABEL[result.kind]}</span>
            {result.truncated && <span className="text-muted-foreground">(truncated for display)</span>}
            {result.display !== "" && (
              <button type="button" onClick={copy} className="ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 font-semibold text-foreground">
                {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                {copied ? "Copied" : "Copy response"}
              </button>
            )}
          </div>
          {result.display !== "" && (
            <pre tabIndex={0} aria-label="Response" className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-100">
              {result.display}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}
