/**
 * mNotify sender-ID registration + status check.
 *
 *   createMnotifySenderId        — POST /senderid/register (one call per sender ID)
 *   queryMnotifySenderIdStatus   — POST /senderid/status
 *
 * Mirrors lib/sms-service.ts's Moolre sender-ID functions exactly, including
 * the fail-soft contract (never throws) and — critically — checking mNotify's
 * own success/failure signal BEFORE trusting any field in the response body
 * as a real status. A previous version of the equivalent Moolre code skipped
 * this check and silently stored an error code as if it were a real status
 * for months; this client is written to not repeat that.
 */
import axios from "axios"

const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY
const MNOTIFY_BASE_URL = "https://api.mnotify.com/api"
// mNotify requires a "purpose" string on registration; there is no per-tenant
// source for this, so a single fixed platform-level purpose is used for every
// sender ID registered through this admin tool.
const REGISTRATION_PURPOSE = "Transactional and marketing SMS for Datagod merchants"

function isSuccess(data: any): boolean {
  return data?.status === "success" || data?.code === "2000"
}

export async function createMnotifySenderId(senderId: string): Promise<{ ok: boolean; message?: string }> {
  if (!MNOTIFY_API_KEY) return { ok: false, message: "mNotify API key not configured" }
  try {
    const response = await axios.post(
      `${MNOTIFY_BASE_URL}/senderid/register?key=${MNOTIFY_API_KEY}`,
      { sender_name: senderId, purpose: REGISTRATION_PURPOSE },
      { headers: { "Content-Type": "application/json" } }
    )
    const ok = isSuccess(response.data)
    return { ok, message: response.data?.message ?? response.data?.summary?.status ?? "" }
  } catch (error) {
    console.error("[mNotify] createSenderId failed:", axios.isAxiosError(error) ? error.message : error)
    return { ok: false, message: axios.isAxiosError(error) ? error.message : "Unknown error" }
  }
}

export async function queryMnotifySenderIdStatus(senderId: string): Promise<{
  rawStatus: string
  localStatus: "pending" | "active" | "rejected"
}> {
  if (!MNOTIFY_API_KEY) return { rawStatus: "no_api_key", localStatus: "pending" }
  try {
    const response = await axios.post(
      `${MNOTIFY_BASE_URL}/senderid/status?key=${MNOTIFY_API_KEY}`,
      { sender_name: senderId },
      { headers: { "Content-Type": "application/json" } }
    )
    if (!isSuccess(response.data)) {
      console.error("[mNotify] querySenderIdStatus returned a failure:", response.data?.code, response.data?.message)
      return { rawStatus: "error", localStatus: "pending" }
    }
    const rawStatus = response.data?.summary?.status ?? "unknown"
    const rawStr = String(rawStatus)
    const localStatus: "pending" | "active" | "rejected" =
      rawStr === "Approved" ? "active"
      : rawStr === "Rejected" ? "rejected"
      : "pending"
    return { rawStatus: rawStr, localStatus }
  } catch (error) {
    console.error("[mNotify] querySenderIdStatus failed:", axios.isAxiosError(error) ? error.message : error)
    return { rawStatus: "error", localStatus: "pending" }
  }
}
