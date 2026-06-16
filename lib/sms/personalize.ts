export const MERGE_TOKENS = ["[FirstName]", "[LastName]", "[Phone]"] as const

export interface RecipientFields {
  firstName?: string
  lastName?: string
  phone: string
}

export function hasMergeTokens(message: string): boolean {
  return MERGE_TOKENS.some((t) => message.includes(t))
}

/**
 * Replace [FirstName], [LastName], [Phone] tokens with recipient values.
 * If a token is present but the corresponding field is missing or empty,
 * the token is left in place (so the caller can see what wasn't filled in).
 */
export function personalize(message: string, recipient: RecipientFields): string {
  let result = message
  if (recipient.firstName) result = result.replaceAll("[FirstName]", recipient.firstName)
  if (recipient.lastName)  result = result.replaceAll("[LastName]",  recipient.lastName)
  result = result.replaceAll("[Phone]", recipient.phone)
  return result
}
