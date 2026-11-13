import type { TextToBuyCtx } from "./contexts"
import { alertAdminsOfRequest } from "./index"

/** Push + email every admin that Text-to-Buy settings changed (names only). Never throws: a failed alert must not fail the save. */
export async function notifyTextToBuyAdmins(alert: TextToBuyCtx): Promise<void> {
  try {
    await alertAdminsOfRequest("text_to_buy", alert)
  } catch {
    // swallowed on purpose
  }
}
