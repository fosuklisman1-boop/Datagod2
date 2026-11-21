import { DEFAULT_ASSISTANT_NAME } from "@/lib/ai-chat-ui/assistant-name"

/** "Your name is X." only for a custom name; the default adds nothing so existing prompts stay byte-identical. */
export function assistantNameLine(name: string): string {
  return name === DEFAULT_ASSISTANT_NAME ? "" : `Your name is ${name}.`
}

/** Appends the name line to a prompt only when the name is custom. */
export function withAssistantName(prompt: string, name: string): string {
  const line = assistantNameLine(name)
  return line ? `${prompt}\n${line}` : prompt
}

/** Push/SMS title + body for a self-notification. A caller title equal to the assistant name (or the default) is not repeated. */
export function selfNotification(name: string, title: string, message: string): { title: string; body: string } {
  return { title: name, body: title !== name && title !== DEFAULT_ASSISTANT_NAME ? `${title}: ${message}` : message }
}
