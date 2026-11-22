import { describe, it, expect } from "vitest"
import { assistantNameLine, withAssistantName, selfNotification } from "./surface-name"

describe("surface names", () => {
  it("whatsapp/cron prompt name only when non-default", () => {
    expect(assistantNameLine("DATAGOD AI")).toBe("")
    expect(withAssistantName("base", "DATAGOD AI")).toBe("base")
    expect(withAssistantName("base", "Kofi Bot")).toBe("base\nYour name is Kofi Bot.")
  })
  it("cron/notify titles use configured name, default unchanged", () => {
    expect(selfNotification("DATAGOD AI", "Reminder", "Pay bill")).toEqual({ title: "DATAGOD AI", body: "Reminder: Pay bill" })
    expect(selfNotification("DATAGOD AI", "DATAGOD AI", "Pay bill")).toEqual({ title: "DATAGOD AI", body: "Pay bill" })
    expect(selfNotification("Kofi Bot", "Reminder", "Pay bill")).toEqual({ title: "Kofi Bot", body: "Reminder: Pay bill" })
    expect(selfNotification("Kofi Bot", "DATAGOD AI", "Pay bill").body).toBe("Pay bill")
    expect(selfNotification("Kofi Bot", "Kofi Bot", "Pay bill").body).toBe("Pay bill")
  })
})
