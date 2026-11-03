import { describe, it, expect } from "vitest"
import { subagentsHostRedirect } from "./join-host"

const ROOT = "datagod.store"

describe("subagentsHostRedirect", () => {
  it("sends subagents.<root>/<handle> to the main-site join page", () => {
    expect(subagentsHostRedirect("subagents.datagod.store", "/kofi-data", ROOT)).toBe("https://www.datagod.store/join/shop/kofi-data")
  })

  it("ignores a port, letter case and a trailing slash", () => {
    expect(subagentsHostRedirect("SubAgents.DataGod.store:443", "/Kofi-Data/", ROOT)).toBe("https://www.datagod.store/join/shop/kofi-data")
  })

  it("sends the bare host and unknown deeper paths to the sub-agents landing page", () => {
    expect(subagentsHostRedirect("subagents.datagod.store", "/", ROOT)).toBe("https://www.datagod.store/join")
    expect(subagentsHostRedirect("subagents.datagod.store", "/a/b", ROOT)).toBe("https://www.datagod.store/join")
  })

  it("strips characters a shop handle can't contain", () => {
    expect(subagentsHostRedirect("subagents.datagod.store", "/kofi%3Cscript%3E", ROOT)).toBe("https://www.datagod.store/join/shop/kofiscript")
    expect(subagentsHostRedirect("subagents.datagod.store", "/%2F%2F", ROOT)).toBe("https://www.datagod.store/join")
  })

  it("leaves static files and every other host alone", () => {
    expect(subagentsHostRedirect("subagents.datagod.store", "/favicon.ico", ROOT)).toBeNull()
    expect(subagentsHostRedirect("www.datagod.store", "/kofi-data", ROOT)).toBeNull()
    expect(subagentsHostRedirect("kofi-data.datagod.store", "/", ROOT)).toBeNull()
    expect(subagentsHostRedirect(null, "/kofi-data", ROOT)).toBeNull()
  })
})
