import { describe, expect, it } from "vitest"
import { TOOL_REGISTRY, toolsFor } from "@/lib/ai-tool-registry"
import { isVoiceChannel, isVoiceSafeTool, voiceToolFilter } from "./tool-filter"

const names = (t: { name: string }[]) => t.map((x) => x.name)
const ACTING = ["update_order_status", "manual_fulfill_order", "manage_my_ussd_shop", "manage_blacklist", "retry_failed_order", "manage_shop", "toggle_ordering", "send_notification"]

describe("voice tool filter", () => {
  it("never offers an acting tool in any context, with the admin catalog on or off", () => {
    for (const ctx of ["home", "storefront", "dashboard", "admin"] as const) {
      for (const catalog of [false, true]) {
        const offered = names(voiceToolFilter(toolsFor(ctx, undefined, catalog)))
        for (const a of ACTING) expect(offered, `${ctx}/${catalog} offers ${a}`).not.toContain(a)
        for (const e of TOOL_REGISTRY) {
          if (e.acts === "money" || e.acts === "account" || e.acts === "ops") expect(offered, e.tool.name).not.toContain(e.tool.name)
        }
      }
    }
  })

  it("keeps the prepare_* confirm-card tools and the read-only tools", () => {
    const dash = names(voiceToolFilter(toolsFor("dashboard")))
    expect(dash).toContain("prepare_wallet_order")
    expect(dash).toContain("get_wallet_balance")
    expect(names(voiceToolFilter(toolsFor("storefront")))).toContain("prepare_checkout")
    const admin = names(voiceToolFilter(toolsFor("admin", undefined, true)))
    expect(admin).toContain("prepare_admin_change")
  })

  it("an unregistered tool name is not voice-safe", () => {
    expect(isVoiceSafeTool("not_a_tool")).toBe(false)
  })

  it("only the exact string 'voice' is the voice channel", () => {
    expect(isVoiceChannel("voice")).toBe(true)
    for (const v of [undefined, null, "text", "VOICE", "voice ", 1, {}]) expect(isVoiceChannel(v)).toBe(false)
  })
})
