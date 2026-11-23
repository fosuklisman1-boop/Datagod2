// Stable anchors for documented errors. Pure: shared by the errors page and the search index.

const PREFIX = /^orders\[i\]:\s*/
const CODE = /^([A-Z][A-Z0-9_]+):/

export function errorCode(message: string): string | null {
  const m = CODE.exec(message.replace(PREFIX, ""))
  return m ? m[1] : null
}

export function errorAnchor(status: number, message: string): string {
  const code = errorCode(message)
  const part = code
    ? code
    : message
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/g, "")
  return `${status}-${part}`.toLowerCase()
}
