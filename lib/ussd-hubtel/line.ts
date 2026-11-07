// Which Hubtel code a request belongs to, from the `line` URL parameter on the Service Interaction URL.
// No parameter is the existing URL. Anything unrecognised (a repeat included) is null: callers must refuse
// it and never guess a menu.
export type HubtelLine = "default" | "main"

/**
 * The body a settings tab posts to the admin config route. This is the one place that decides which code a save
 * reaches: a shop code save carries no `line`, so it can never touch the main code's settings, and the reverse.
 */
export function hubtelSaveBody(line: "shop" | "main", patch: object): object {
  if (line === "main") return { ...patch, line: "main" }
  return patch
}

/** `values` is `searchParams.getAll("line")`. */
export function parseHubtelLine(values: string[]): HubtelLine | null {
  if (values.length === 0) return "default"
  return values.length === 1 && values[0] === "main" ? "main" : null
}
