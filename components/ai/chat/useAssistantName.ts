"use client"

import { useEffect, useState } from "react"
import { DEFAULT_ASSISTANT_NAME, normaliseAssistantName } from "@/lib/ai-chat-ui/assistant-name"
import type { Audiences } from "@/lib/ai-console/settings"

export interface AssistantProfile {
  name: string
  /** null until the profile has loaded (or if it could not be read): widgets stay visible, as before. */
  audiences: Audiences | null
  loaded: boolean
}

const FALLBACK: AssistantProfile = { name: DEFAULT_ASSISTANT_NAME, audiences: null, loaded: false }

let cached: AssistantProfile | null = null
let inflight: Promise<AssistantProfile> | null = null

function parseAudiences(a: unknown): Audiences | null {
  if (!a || typeof a !== "object") return null
  const o = a as Record<string, unknown>
  const f = (k: string) => o[k] !== false
  return { admins: f("admins"), signedIn: f("signedIn"), shopVisitors: f("shopVisitors"), publicVisitors: f("publicVisitors") }
}

function load(): Promise<AssistantProfile> {
  if (cached) return Promise.resolve(cached)
  inflight ??= fetch("/api/ai/assistant-profile")
    .then((r) => (r.ok ? r.json() : null))
    .then((j): AssistantProfile => ({ name: normaliseAssistantName(j?.name), audiences: parseAudiences(j?.audiences), loaded: true }))
    .catch((): AssistantProfile => ({ name: DEFAULT_ASSISTANT_NAME, audiences: null, loaded: true }))
    .then((p) => (cached = p))
  return inflight
}

/** Name + audience switches, fetched once per page load; any error falls back to the default name with everything on. */
export function useAssistantProfile(): AssistantProfile {
  const [profile, setProfile] = useState<AssistantProfile>(cached ?? FALLBACK)
  useEffect(() => {
    let live = true
    void load().then((p) => live && setProfile(p))
    return () => {
      live = false
    }
  }, [])
  return profile
}

/** Fetches the assistant's display name once per page load; falls back to the default on any error. */
export function useAssistantName(): string {
  return useAssistantProfile().name
}
