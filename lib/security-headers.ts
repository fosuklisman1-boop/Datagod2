// Values for the security headers set in middleware.ts that Clings voice/video calls depend on.

// Microphone + camera are allowed for this site only (Clings voice/video calls); other origins (iframes) stay denied.
export const PERMISSIONS_POLICY = "camera=(self), microphone=(self), geolocation=()"

// connect-src entries the browser needs for a Nuance Live call: Nuance's API (create the conversation, follow its
// events) and the LiveKit room it runs in (signalling over wss, region/health checks over https).
export const VOICE_CONNECT_SRC = [
  "https://api.nuancelabs.ai",
  "https://*.livekit.cloud",
  "wss://*.livekit.cloud",
]
