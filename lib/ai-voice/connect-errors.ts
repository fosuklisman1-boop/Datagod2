// Maps a failed call start (a token-route fallback reason or an SDK connect() error) to one calm line for the user.
// SDK errors are matched by `name` so this stays free of the browser SDK.
import type { FallbackReason } from "./nuance"

const BUSY = "Calls are busy right now — you can keep chatting here."

export function connectErrorMessage(err: unknown, reason?: FallbackReason): string {
  switch (reason) {
    case "credits":
    case "busy":
    case "unavailable":
    case "review_pending":
      return BUSY
    case "daily_cap":
      return "You've used today's calls. You can keep chatting here."
    case "visitor_cap":
      return "Calls are full for today. Sign in to call, or keep chatting here."
    case "policy":
      return "Calls are paused for this account for a while."
  }
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined
  switch (name) {
    case "PolicyCurfewError":
      return "Calls are paused for this account for a while."
    case "MediaAccessError":
      return "Allow the microphone (and camera for video) to call."
    case "WebRTCUnavailableError":
      return "This browser can't make calls. Try Chrome, or keep chatting here."
    case "JoinTimeoutError":
      return "Couldn't connect the call. A VPN or data saver can block calls."
    default:
      return "Couldn't start the call — keep chatting here."
  }
}
