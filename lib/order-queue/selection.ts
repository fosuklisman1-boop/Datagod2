/** Hard cap on how many orders one selection (and one bulk action) may cover. */
export const SELECTION_CAP = 200

export type SelectionState = { ids: Set<string>; allMatching: boolean; error?: "cap" }

export type SelectionAction =
  | { type: "toggle"; id: string }
  | { type: "selectPage"; ids: string[] }
  | { type: "clear" }
  | { type: "selectAllMatching"; total: number }

export const emptySelection = (): SelectionState => ({ ids: new Set(), allMatching: false })

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "toggle": {
      const ids = new Set(state.ids)
      if (ids.has(action.id)) ids.delete(action.id)
      else ids.add(action.id)
      return { ids, allMatching: false }
    }
    case "selectPage": {
      const ids = new Set(state.ids)
      for (const id of action.ids) ids.add(id)
      return { ids, allMatching: state.allMatching }
    }
    case "clear":
      return emptySelection()
    case "selectAllMatching":
      if (action.total > SELECTION_CAP) return { ids: state.ids, allMatching: false, error: "cap" }
      return { ids: state.ids, allMatching: true }
  }
}
