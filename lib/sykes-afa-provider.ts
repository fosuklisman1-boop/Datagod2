/**
 * Sykes AFA Registration Provider
 *
 * Handles POST /api/afa/register against the Sykes API.
 * Reuses the same base URL and API key as the MTN data provider.
 */

const SYKES_API_BASE = process.env.MTN_API_BASE_URL || "https://sykesofficial.net"
const SYKES_API_KEY = process.env.MTN_API_KEY || ""
const REQUEST_TIMEOUT = parseInt(process.env.MTN_REQUEST_TIMEOUT || "30000", 10)

export interface AfaRegisterPayload {
  Full_Name: string
  Ghana_Card_Number: string
  Occupation_type: string
}

export interface AfaRegisterResponse {
  success: boolean
  message?: string
  reference?: string
  [key: string]: unknown
}

/**
 * Submit an AFA registration to the Sykes API.
 * Returns a normalised { success, message, reference } object.
 */
export async function registerAfaViaSykes(
  payload: AfaRegisterPayload
): Promise<AfaRegisterResponse> {
  console.log("[Sykes-AFA] Registering:", { Full_Name: payload.Full_Name })

  let responseText: string
  let httpStatus: number

  try {
    const response = await fetch(`${SYKES_API_BASE}/api/afa/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": SYKES_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })

    httpStatus = response.status
    responseText = await response.text()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[Sykes-AFA] Network error:", msg)
    return { success: false, message: `Network error: ${msg}` }
  }

  // Strip any PHP warnings/HTML that may precede the JSON body
  const jsonMatch = responseText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error("[Sykes-AFA] No JSON in response:", responseText.slice(0, 300))
    return {
      success: false,
      message: `Unexpected API response (HTTP ${httpStatus}): ${responseText.slice(0, 200)}`,
    }
  }

  let data: AfaRegisterResponse
  try {
    data = JSON.parse(jsonMatch[0]) as AfaRegisterResponse
  } catch {
    return {
      success: false,
      message: `Failed to parse API response: ${responseText.slice(0, 200)}`,
    }
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    console.error("[Sykes-AFA] HTTP error:", httpStatus, data)
    return {
      success: false,
      message: data.message || `API returned HTTP ${httpStatus}`,
    }
  }

  if (!data.success) {
    console.warn("[Sykes-AFA] API returned success=false:", data)
    return {
      success: false,
      message: data.message || "Registration rejected by Sykes API",
    }
  }

  console.log("[Sykes-AFA] Registration successful:", data.reference || "(no ref)")
  return data
}
