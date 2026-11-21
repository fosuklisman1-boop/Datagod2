import { describe, it, expect } from "vitest"
import { looksLikeOrderPrompt } from "./prompt-order-detect"

describe("looksLikeOrderPrompt", () => {
  it("detects_buy_1gb_weekly", () => {
    expect(looksLikeOrderPrompt("Buy 1GB MTN data for 0241234567 every Monday")).toBe(true)
  })
  it("detects_send_2gb_daily", () => {
    expect(looksLikeOrderPrompt("send 2 gb daily to 0551234567")).toBe(true)
  })
  it("detects_top_up_data", () => {
    expect(looksLikeOrderPrompt("Top up data bundle for my mum each week")).toBe(true)
    expect(looksLikeOrderPrompt("topup data every Friday")).toBe(true)
  })
  it("ignores_balance_report", () => {
    expect(looksLikeOrderPrompt("Tell me my wallet balance every morning")).toBe(false)
  })
  it("ignores_order_status_check", () => {
    expect(looksLikeOrderPrompt("check my order status")).toBe(false)
  })
  it("ignores_order_history_report", () => {
    expect(looksLikeOrderPrompt("Show a summary of my order history and data usage")).toBe(false)
    expect(looksLikeOrderPrompt("List my orders for today, 5GB packages")).toBe(false)
  })
  it("does not trip on border or reorder", () => {
    expect(looksLikeOrderPrompt("reorder status of my data")).toBe(false)
    expect(looksLikeOrderPrompt("border data")).toBe(false)
  })
  it("needs both a verb and a data marker", () => {
    expect(looksLikeOrderPrompt("Buy airtime every day")).toBe(false)
    expect(looksLikeOrderPrompt("my data usage")).toBe(false)
  })
})
