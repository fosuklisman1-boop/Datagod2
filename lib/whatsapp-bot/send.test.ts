import { formatForWhatsApp, sendWhatsAppText } from "@/lib/whatsapp-bot/send"

describe("formatForWhatsApp", () => {
  it("converts **bold** and __bold__ to WhatsApp single-asterisk bold", () => {
    expect(formatForWhatsApp("**hi** and __there__")).toBe("*hi* and *there*")
  })

  it("converts markdown headings to bold lines", () => {
    expect(formatForWhatsApp("## Title")).toBe("*Title*")
    expect(formatForWhatsApp("   ### Indented")).toBe("*Indented*")
  })

  it("rewrites markdown links to 'label (url)'", () => {
    expect(formatForWhatsApp("see [our site](https://x.co)")).toBe("see our site (https://x.co)")
  })

  it("leaves plain text and existing single-asterisk bold untouched", () => {
    expect(formatForWhatsApp("just text")).toBe("just text")
    expect(formatForWhatsApp("*already bold*")).toBe("*already bold*")
  })

  it("returns falsy input unchanged", () => {
    expect(formatForWhatsApp("")).toBe("")
  })
})

// sendWhatsAppText's optional 3rd param (phoneNumberId) lets a future "shop"
// WhatsApp number reuse this same sender without disturbing any of the many
// existing 2-arg call sites, which must keep sending from the main number
// (WHATSAPP_PHONE_NUMBER_ID) exactly as today.
describe("sendWhatsAppText", () => {
  const MAIN_PNID = "MAIN_PNID_111"
  const fetchMock = vi.fn()

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as Response
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    process.env.WHATSAPP_PHONE_NUMBER_ID = MAIN_PNID
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("with only 2 args, sends from the main WHATSAPP_PHONE_NUMBER_ID", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.MAIN1" }] }))

    const wamid = await sendWhatsAppText("233241234567", "hi")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(`/${MAIN_PNID}/messages`)
    expect(String(url)).not.toContain("SHOP_PNID_123")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      messaging_product: "whatsapp",
      to: "233241234567",
      type: "text",
      text: { body: "hi" },
    })
    expect(wamid).toBe("wamid.MAIN1")
  })

  it("with a 3rd arg, sends from that phone_number_id instead of the main one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.SHOP1" }] }))

    const wamid = await sendWhatsAppText("233241234567", "hi", "SHOP_PNID_123")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain("/SHOP_PNID_123/messages")
    expect(String(url)).not.toContain(MAIN_PNID)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      messaging_product: "whatsapp",
      to: "233241234567",
      type: "text",
      text: { body: "hi" },
    })
    expect(wamid).toBe("wamid.SHOP1")
  })

  it("returns null and does not call fetch when neither phoneNumberId nor env is set", async () => {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID

    const wamid = await sendWhatsAppText("233241234567", "hi")

    expect(wamid).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
