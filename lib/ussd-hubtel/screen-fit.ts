// lib/ussd-hubtel/screen-fit.ts
// Screen helpers for list menus built from provider text (Network Plans): page a list, keep every
// screen within the USSD limit by shortening item labels (never the price or the footer), and keep
// product words ("data", "bundle") off the screen.
import { USSD_SCREEN_LIMIT } from "./protocol"

/**
 * Hubtel/telco wording rewritten for the menus: "bundle(s)" dropped (first, so "Databundle" => "Data"), then
 * the whole word "data" => "Internet" ("metadata" is left alone). Nothing left => "Plan".
 */
export function noProductWords(text: string): string {
  const out = text
    .replace(/bundles?/gi, "")
    // Whole word, with letters (not \w) as the boundary so "Data_1" / "Data1" are still rewritten.
    .replace(/(?<![a-z])data(?![a-z])/gi, "Internet")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/[ \t]+/g, " ")
    .trim()
  return out === "" ? "Plan" : out
}

export interface PageSlice<T> { items: T[]; page: number; hasNext: boolean; hasPrev: boolean }

/** Page `page` (clamped to the last page) of `all`, `size` per page. */
export function pageSlice<T>(all: readonly T[], page: number, size: number): PageSlice<T> {
  const last = Math.max(0, Math.ceil(all.length / size) - 1)
  const p = Math.min(Math.max(0, Math.floor(page) || 0), last)
  return { items: all.slice(p * size, (p + 1) * size), page: p, hasNext: (p + 1) * size < all.length, hasPrev: p > 0 }
}

export interface ListItem { label: string; suffix?: string }

const MIN_LABEL = 4

/**
 * "<header>\n1. <label> <suffix>\n…\n<footer lines>", at most `limit` chars. When too long the longest
 * label is shortened one char at a time (suffixes such as prices and the footer are kept whole). If the
 * fixed parts alone are still too long the text is cut at `limit` (fitMessage would do the same).
 */
export function fitListScreen(header: string, items: readonly ListItem[], footer: readonly string[], limit = USSD_SCREEN_LIMIT): string {
  const labels = items.map(i => i.label)
  const render = () => [
    ...(header ? [header] : []),
    ...items.map((it, i) => `${i + 1}. ${labels[i]}${it.suffix ? " " + it.suffix : ""}`),
    ...footer,
  ].join("\n")
  let text = render()
  while (text.length > limit) {
    let longest = -1
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].length > MIN_LABEL && (longest === -1 || labels[i].length > labels[longest].length)) longest = i
    }
    if (longest === -1) return text.slice(0, limit)
    labels[longest] = labels[longest].slice(0, -1).trimEnd()
    text = render()
  }
  return text
}

/** Shorten `text` to at most `max` chars (min 1). */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(1, max)).trimEnd()
}
