"use client"

import dynamic from "next/dynamic"

// The chat widget pulls in react-markdown; load it after hydration, client-only,
// so it stays out of the homepage / auth pages' initial JS.
export const HomeAIChatWidget = dynamic(
  () => import("./AIChatWidget").then((m) => m.HomeAIChatWidget),
  { ssr: false },
)
