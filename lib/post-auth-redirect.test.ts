import { describe, it, expect } from "vitest"
import { safeRedirectPath, authUrl } from "./post-auth-redirect"

describe("safeRedirectPath", () => {
  it("keeps internal paths, including query strings", () => {
    expect(safeRedirectPath("/dashboard/my-shop")).toBe("/dashboard/my-shop")
    expect(safeRedirectPath("/dashboard/airtime?x=1")).toBe("/dashboard/airtime?x=1")
  })
  it("falls back for empty/absent values", () => {
    expect(safeRedirectPath(null)).toBe("/dashboard")
    expect(safeRedirectPath("")).toBe("/dashboard")
    expect(safeRedirectPath(undefined, "/x")).toBe("/x")
  })
  it("rejects open-redirect shapes", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "/a\\b", "/a\nb"]) {
      expect(safeRedirectPath(bad)).toBe("/dashboard")
    }
  })
  it("rejects /auth paths to avoid loops", () => {
    expect(safeRedirectPath("/auth/login")).toBe("/dashboard")
    expect(safeRedirectPath("/auth")).toBe("/dashboard")
  })
})

describe("authUrl", () => {
  it("adds an encoded redirect only when the destination is safe", () => {
    expect(authUrl("signup", "/dashboard/developer")).toBe("/auth/signup?redirect=%2Fdashboard%2Fdeveloper")
    expect(authUrl("login", "//evil.com")).toBe("/auth/login")
    expect(authUrl("signup")).toBe("/auth/signup")
  })
})
