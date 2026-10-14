/**
 * Mask an account holder's name for public (storefront) verify responses: each word keeps its first 3 characters
 * ("KLINSMAN" → "KLI***"); words of 3 characters or fewer keep only the first ("ABA" → "A***").
 * null / empty stays null.
 */
export function maskName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return words
    .map(w => {
      const chars = Array.from(w)
      return (chars.length <= 3 ? chars[0] : chars.slice(0, 3).join("")) + "***"
    })
    .join(" ")
}
