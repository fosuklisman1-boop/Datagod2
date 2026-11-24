// Admin console reads: one rpc/table read with a generic error, and a clear "Not set up yet" when migration 0197
// has not been applied (function or table missing). Logs carry only the function/table name and the error code.
import type { RpcClient, WriteResult } from "./write-common"

export const NOT_SET_UP = {
  error: "Not set up yet: the API admin console database update has not been applied.",
  code: "not_set_up",
}
const GENERIC_READ = { error: "Could not load this. Please try again.", code: "error" }

interface DbError {
  code?: string
  message?: string
}

/** Function or table missing (0197 not applied). Codes first; wording only as a fallback for PostgREST. */
export function isNotSetUp(err: unknown): boolean {
  const e = (err ?? {}) as DbError
  if (e.code === "42883" || e.code === "PGRST202" || e.code === "42P01" || e.code === "PGRST205") return true
  const m = (e.message ?? "").toLowerCase()
  return m.includes("could not find the function") || m.includes("could not find the table")
}

export function readFailure(where: string, err: unknown): WriteResult {
  const notSetUp = isNotSetUp(err)
  console.error("[api-v2 admin read]", where, ((err ?? {}) as DbError).code ?? "unknown")
  return { status: 500, body: notSetUp ? NOT_SET_UP : GENERIC_READ }
}

export async function callRead(
  client: RpcClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; result: WriteResult }> {
  try {
    const res = await client.rpc(fn, args)
    if (res.error) return { ok: false, result: readFailure(fn, res.error) }
    return { ok: true, data: res.data }
  } catch {
    return { ok: false, result: readFailure(fn, null) }
  }
}
