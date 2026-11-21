"use client"

import { useEffect, useState } from "react"
import { DEFAULT_ASSISTANT_NAME, normaliseAssistantName } from "@/lib/ai-chat-ui/assistant-name"

let cached: string | null = null
let inflight: Promise<string> | null = null

function load(): Promise<string> {
  if (cached) return Promise.resolve(cached)
  inflight ??= fetch("/api/ai/assistant-profile")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => normaliseAssistantName(j?.name))
    .catch(() => DEFAULT_ASSISTANT_NAME)
    .then((n) => (cached = n))
  return inflight
}

/** Fetches the assistant's display name once per page load; falls back to the default on any error. */
export function useAssistantName(): string {
  const [name, setName] = useState(cached ?? DEFAULT_ASSISTANT_NAME)
  useEffect(() => {
    let live = true
    void load().then((n) => live && setName(n))
    return () => {
      live = false
    }
  }, [])
  return name
}
