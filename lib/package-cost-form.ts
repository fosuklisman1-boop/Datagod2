// Pure helpers for the admin packages form: when to send cost_price. Sending null DELETES the stored cost, so the key is
// only sent when the admin really changed the field and the costs were loaded.

export const MAX_COST = 99999999.99 // numeric(10,2)

export type CostPayload = { kind: "omit" } | { kind: "set"; value: number | null } | { kind: "error"; message: string }

/** Text for the cost input when a package is opened for editing. */
export function costFieldText(loaded: number | null | undefined): string {
  return loaded == null ? "" : String(loaded)
}

/**
 * loaded: the cost loaded for this package (null/undefined = none set); edited: the input text; loadFailed: the costs
 * request failed (the loaded value is then unknown, so never send anything).
 */
export function costPayload(loaded: number | null | undefined, edited: string, loadFailed: boolean): CostPayload {
  if (loadFailed) return { kind: "omit" }
  const text = edited.trim()
  const before = costFieldText(loaded)
  if (text === before) return { kind: "omit" }
  if (text !== "" && before !== "" && Number(text) === Number(before)) return { kind: "omit" }
  if (text === "") return before === "" ? { kind: "omit" } : { kind: "set", value: null }
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0 || n > MAX_COST) {
    return { kind: "error", message: "Our cost must be a number from 0 to 99999999.99" }
  }
  return { kind: "set", value: n }
}
