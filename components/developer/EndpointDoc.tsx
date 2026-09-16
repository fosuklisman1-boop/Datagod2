// components/developer/EndpointDoc.tsx
"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Copy, Check } from "lucide-react"
import type { ApiDocSection } from "@/lib/api-docs-registry"

function CopyableBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="bg-muted/50 border rounded-lg p-4 pr-12 text-xs overflow-x-auto font-mono">{text}</pre>
      <Button
        size="icon"
        variant="ghost"
        className="absolute top-2 right-2 h-7 w-7"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
      </Button>
    </div>
  )
}

export function EndpointDoc({ section }: { section: ApiDocSection }) {
  return (
    <div className="space-y-8">
      {section.operations.map((op) => (
        <div key={`${op.method}-${op.path}`} className="space-y-3">
          <div className="flex items-center gap-2 font-mono text-sm">
            <Badge className={op.method === "GET" ? "bg-sky-600 hover:bg-sky-600 text-white" : "bg-emerald-600 hover:bg-emerald-600 text-white"}>
              {op.method}
            </Badge>
            <span>{op.path}</span>
          </div>
          <p className="text-sm text-muted-foreground">{op.description}</p>

          {op.params && op.params.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th scope="col" className="p-2">Param</th>
                    <th scope="col" className="p-2">Type</th>
                    <th scope="col" className="p-2">Required</th>
                    <th scope="col" className="p-2">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {op.params.map((p) => (
                    <tr key={p.name}>
                      <td className="p-2 font-mono">{p.name}</td>
                      <td className="p-2 text-muted-foreground">{p.type}</td>
                      <td className="p-2">{p.required ? "Yes" : "No"}</td>
                      <td className="p-2 text-muted-foreground">{p.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Request</p>
            <CopyableBlock text={op.curl} label={`${op.method} ${op.path} request`} />
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Success response</p>
            <CopyableBlock text={op.successExample} label={`${op.method} ${op.path} success response`} />
          </div>
          {op.errorExamples.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Example errors</p>
              <div className="space-y-2">
                {op.errorExamples.map((e, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge variant="outline" className="font-mono mt-0.5">{e.status}</Badge>
                    <pre className="bg-muted/50 border rounded-lg p-3 text-xs overflow-x-auto font-mono flex-1">{e.body}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
