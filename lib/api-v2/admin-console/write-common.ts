// Shared by the admin console write libs: result shape, the refused-character class (mirrors migration 0197),
// UUID check and rpc outcome mapping. Never logs anything but the error code.
import type { RpcClient } from "@/lib/api-v2/approvals"

export type { RpcClient }

export interface WriteResult {
  status: number
  body: Record<string, unknown>
}

export const NO_ADMIN: WriteResult = { status: 403, body: { error: "Sign in with an admin account to do this." } }

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Same class as the SQL: C0, DEL, C1, NBSP, soft hyphen, zero-width, bidi, variation selectors, filler characters.
export const REFUSED_SINGLE_LINE =
  /[\u0000-\u001F\u007F-\u009F\u00A0\u00AD\u061C\u115F\u1160\u180E\u2000-\u200F\u2028-\u202E\u2060-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/
// Body text may keep \t \n \r.
export const REFUSED_MULTI_LINE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00A0\u00AD\u061C\u115F\u1160\u180E\u2000-\u200F\u2028-\u202E\u2060-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/

/** Length in characters (code points), as Postgres char_length counts. */
export const charLen = (s: string): number => Array.from(s).length

export const bad = (error: string, code = "bad_input"): WriteResult => ({ status: 400, body: { error, code } })

const GENERIC: WriteResult = { status: 500, body: { error: "Something went wrong. Please try again.", code: "error" } }

const ERROR_BY_CODE: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: "Not found." },
  bad_reason: { status: 400, error: "Give a reason of 3 to 200 characters, plain text." },
  bad_message: { status: 400, error: "The message must be at most 200 characters of plain text." },
  bad_input: { status: 400, error: "Some fields are not valid." },
  too_many: { status: 409, error: "Too many announcements. Delete an old one first." },
}

/** Runs one api_v2_* write and maps its jsonb result. A failed call returns a generic 500 and logs only the code. */
export async function callWrite(
  client: RpcClient,
  fn: string,
  args: Record<string, unknown>
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; result: WriteResult }> {
  let res: { data: unknown; error: { code?: string; message?: string } | null }
  try {
    res = await client.rpc(fn, args)
  } catch {
    console.error("[api-v2 admin write] rpc threw", fn)
    return { ok: false, result: GENERIC }
  }
  if (res.error) {
    console.error("[api-v2 admin write] rpc error", fn, res.error.code ?? "unknown")
    return { ok: false, result: GENERIC }
  }
  const d = res.data as Record<string, unknown> | null
  if (d && d.ok === true) return { ok: true, data: d }
  const mapped = d && typeof d.code === "string" ? ERROR_BY_CODE[d.code] : undefined
  if (mapped) return { ok: false, result: { status: mapped.status, body: { error: mapped.error, code: d!.code } } }
  console.error("[api-v2 admin write] unexpected result", fn)
  return { ok: false, result: GENERIC }
}
