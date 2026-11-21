// Fixed server-side tone lines. Admins pick a preset by id; free text never reaches the prompt.
export const TONES = ["default", "professional", "friendly", "fun", "strict", "concise"] as const
export type AssistantTone = (typeof TONES)[number]

const SAFETY = "If a customer sounds upset, always reply calmly and seriously, and never joke about money, failed orders or complaints."

const TONE_LINES: Record<Exclude<AssistantTone, "default">, string> = {
  professional: `TONE: Be polished, courteous and businesslike. Use clear, formal-but-warm wording. ${SAFETY}`,
  friendly: `TONE: Be warm, welcoming and encouraging, like a helpful neighbour. ${SAFETY}`,
  fun: `TONE: Be upbeat and lightly playful where it fits, with the occasional light touch of humour. ${SAFETY}`,
  strict: `TONE: Be direct and no-nonsense. Stick to the facts and the rules, and do not bend them. ${SAFETY}`,
  concise: `TONE: Be brief. Give the shortest helpful answer, skip filler and keep lists short. ${SAFETY}`,
}

/** The tone line for a preset, or "" for 'default' (so default prompts stay byte-identical). */
export function toneLine(tone: AssistantTone | undefined): string {
  return !tone || tone === "default" ? "" : TONE_LINES[tone]
}
