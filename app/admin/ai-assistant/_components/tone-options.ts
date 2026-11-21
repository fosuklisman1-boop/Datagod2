import type { AssistantTone } from "@/lib/ai-console/tone"

// Display-only copy for the tone cards. The examples are never sent to the model;
// the server uses its own fixed tone lines (lib/ai-console/tone.ts).
export const TONE_OPTIONS: { id: AssistantTone; title: string; blurb: string; example: string }[] = [
  { id: "default", title: "Default (current behaviour)", blurb: "Keeps the assistant exactly as it works today.",
    example: "Your MTN 5GB bundle was delivered at 2:14 PM. If it has not shown up in 10 minutes, tell me and I will check." },
  { id: "professional", title: "Professional", blurb: "Polished, courteous and businesslike.",
    example: "Good afternoon. Your MTN 5GB bundle was delivered at 2:14 PM. Should it not reflect shortly, please let me know and I will look into it." },
  { id: "friendly", title: "Friendly", blurb: "Warm and welcoming, like a helpful neighbour.",
    example: "Good news, your MTN 5GB bundle landed at 2:14 PM! If it has not reached you yet, just say and I will help sort it out." },
  { id: "fun", title: "Fun", blurb: "Upbeat with a light touch of humour.",
    example: "Your 5GB just zoomed in at 2:14 PM. Go and enjoy it! If it is playing hide and seek, tell me and I will find it." },
  { id: "strict", title: "Strict", blurb: "Direct and by the book.",
    example: "The 5GB bundle was delivered at 2:14 PM. If it is not reflected within 10 minutes, report it and the order will be checked." },
  { id: "concise", title: "Concise", blurb: "The shortest helpful answer.",
    example: "Delivered at 2:14 PM. Not there in 10 minutes? Tell me." },
]

export const TONE_SAFETY_NOTE = "If a customer sounds upset, the assistant always replies calmly and seriously, whatever tone you pick."
