export type ChatWidget = "home" | "storefront" | "dashboard" | "admin"

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function historyKey(widget: ChatWidget, who: { userId?: string | null; shopId?: string | null }): string {
  const user = who.userId || "guest"
  return who.shopId ? `datagod-ai-chat:${widget}:${who.shopId}:${user}` : `datagod-ai-chat:${widget}:${user}`
}

export function trimHistory<T>(messages: T[], max = 30): T[] {
  return messages.length > max ? messages.slice(messages.length - max) : messages
}

/** Never throws: null storage, blocked storage, or bad JSON all read as "nothing saved". */
export function safeLoad(storage: StorageLike | null | undefined, key: string): unknown {
  try {
    const raw = storage?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function safeSave(storage: StorageLike | null | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota: history is a convenience */
  }
}

export function safeClear(storage: StorageLike | null | undefined, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    /* ignore */
  }
}
