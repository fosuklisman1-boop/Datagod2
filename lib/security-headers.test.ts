import { describe, it, expect } from "vitest"
import { PERMISSIONS_POLICY, VOICE_CONNECT_SRC } from "./security-headers"

describe("security headers for Clings voice calls", () => {
  it("lets only this site use the microphone and camera, never other origins, and keeps geolocation off", () => {
    expect(PERMISSIONS_POLICY).toBe("camera=(self), microphone=(self), geolocation=()")
  })

  it("allows the browser to reach Nuance's API and its LiveKit call servers (https + wss)", () => {
    expect(VOICE_CONNECT_SRC).toEqual([
      "https://api.nuancelabs.ai",
      "https://*.livekit.cloud",
      "wss://*.livekit.cloud",
    ])
  })
})
