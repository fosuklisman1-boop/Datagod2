// Which Hubtel code a request belongs to, from the `line` URL parameter on the Service Interaction URL.
// No parameter is the existing URL. Anything unrecognised (a repeat included) is null: callers must refuse
// it and never guess a menu.
export type HubtelLine = "default" | "main"

/** `values` is `searchParams.getAll("line")`. */
export function parseHubtelLine(values: string[]): HubtelLine | null {
  if (values.length === 0) return "default"
  return values.length === 1 && values[0] === "main" ? "main" : null
}
