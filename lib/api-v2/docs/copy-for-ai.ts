// Pure helper behind the "Copy for AI" button: fetch the Markdown description of the API and copy it.
// Never throws; resolves false on any failure so the UI can show an inline error.

export const API_MARKDOWN_PATH = "/developers/api.md"

type FetchLike = (input: string) => Promise<{ ok: boolean; text: () => Promise<string> }>

export async function copyApiMarkdown(
  fetchImpl: FetchLike,
  writeImpl: (text: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    const res = await fetchImpl(API_MARKDOWN_PATH)
    if (!res.ok) return false
    const text = await res.text()
    if (!text) return false
    return await writeImpl(text)
  } catch {
    return false
  }
}
