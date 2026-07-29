import {
  shopEnterCodeMenu, shopInvalidCodeMenu, shopProductMenu, shopNetworkMenu, shopBundleMenu,
  shopRecipientPrompt, shopPaymentPhonePrompt, shopInvalidPaymentPhoneMenu, shopConfirmMenu,
  shopPaymentSentMenu, shopOtpMenu, shopAirtimeRecipientPrompt, shopAirtimeNetworkMenu,
  shopAirtimeAmountPrompt, shopAirtimeConfirmMenu, shopRcBoardMenu, shopRcQtyPrompt,
  shopRcConfirmMenu, sortNetworks, PAGE_SIZE,
} from "./shop-menus"
import { WaShopBundleOption } from "./shop-types"

describe("whatsapp-bot shop-menus", () => {
  describe("entry / product menus", () => {
    it("shopEnterCodeMenu prompts for a code and offers exit", () => {
      const text = shopEnterCodeMenu()
      expect(text).toContain("Enter shop code")
      expect(text).toContain("0. Exit")
    })

    it("shopInvalidCodeMenu surfaces the reason before re-prompting", () => {
      const text = shopInvalidCodeMenu("Shop code not found.")
      expect(text).toContain("Shop code not found.")
      expect(text).toContain("Enter shop code")
    })

    it("shopProductMenu shows the shop name and all three products by default", () => {
      const text = shopProductMenu("Kofi's Data Shop")
      expect(text).toContain("Kofi's Data Shop")
      expect(text).toContain("1. Data Bundle")
      expect(text).toContain("2. Airtime")
      expect(text).toContain("3. Results Checker")
    })

    it("shopProductMenu omits Data Bundle when showData is false", () => {
      const text = shopProductMenu("Kofi's Data Shop", false)
      expect(text).not.toContain("Data Bundle")
      expect(text).toContain("1. Airtime")
      expect(text).toContain("2. Results Checker")
    })
  })

  describe("shopNetworkMenu", () => {
    it("lists the shop name and networks in priority order (mtn first)", () => {
      const text = shopNetworkMenu("Ama Shop", ["AirtelTigo", "MTN", "Telecel"])
      expect(text).toContain("Ama Shop")
      const mtnIdx = text.indexOf("MTN")
      const telecelIdx = text.indexOf("Telecel")
      const atIdx = text.indexOf("AirtelTigo")
      expect(mtnIdx).toBeGreaterThan(-1)
      expect(mtnIdx).toBeLessThan(telecelIdx)
      expect(telecelIdx).toBeLessThan(atIdx)
      expect(text).toContain("0. Back")
    })

    it("reuses the same sortNetworks the USSD shop uses (not a duplicate)", () => {
      expect(sortNetworks(["Telecel", "MTN"])).toEqual(["MTN", "Telecel"])
    })
  })

  describe("shopBundleMenu", () => {
    const bundles: WaShopBundleOption[] = [
      { id: "p1", size: "1GB", price: 5.5 },
      { id: "p2", size: "2GB", price: 10 },
    ]

    it("lists each bundle with its correct 1-based number, size, and price", () => {
      const { text, shown } = shopBundleMenu("Shop A", bundles, 0, 2)
      expect(text).toContain("Shop A")
      expect(text).toContain("1. 1GB - GHS 5.50")
      expect(text).toContain("2. 2GB - GHS 10.00")
      expect(shown).toBe(2)
    })

    it("offsets numbering by page and omits More... when nothing remains", () => {
      const { text } = shopBundleMenu("Shop A", bundles, 1, 7) // page 1, PAGE_SIZE=5 -> offset 5
      expect(text).toContain(`${1 * PAGE_SIZE + 1}. 1GB - GHS 5.50`)
      expect(text).toContain(`${1 * PAGE_SIZE + 2}. 2GB - GHS 10.00`)
      expect(text).not.toContain("More...")
      expect(text).toContain("0. Back")
    })

    it("appends a numbered More... option when the page doesn't reach the total", () => {
      const { text } = shopBundleMenu("Shop A", bundles, 0, 5) // 2 shown, 5 total -> more remain
      expect(text).toContain("3. More...")
    })
  })

  describe("recipient / payment-phone prompts", () => {
    it("shopRecipientPrompt asks who receives the data", () => {
      expect(shopRecipientPrompt()).toContain("recipient number")
    })

    it("shopPaymentPhonePrompt matches the main WhatsApp bot's WA_ENTER_PAYMENT_PHONE wording", () => {
      expect(shopPaymentPhonePrompt()).toBe("Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel")
    })

    it("shopInvalidPaymentPhoneMenu flags an invalid number and re-prompts", () => {
      const text = shopInvalidPaymentPhoneMenu()
      expect(text).toContain("Invalid number")
      expect(text).toContain("0244123456")
    })
  })

  describe("shopConfirmMenu", () => {
    it("shows the bundle, formatted local recipient and payment numbers, and the price", () => {
      const text = shopConfirmMenu("Shop A", "MTN", "2GB", 10.5, "233241111111", "233245555555")
      expect(text).toContain("Shop A")
      expect(text).toContain("2GB MTN")
      expect(text).toContain("To: 0241111111")
      expect(text).toContain("GHS 10.50")
      expect(text).toContain("0245555555")
      expect(text).toContain("1. Pay now")
      expect(text).toContain("2. Cancel")
    })
  })

  describe("payment-sent / otp", () => {
    it("shopPaymentSentMenu tells the customer to reply here with an OTP, not 'Redial'", () => {
      const text = shopPaymentSentMenu("0241111111")
      expect(text).toContain("0241111111")
      expect(text).toContain("reply here with it")
      expect(text).not.toContain("Redial")
    })

    it("shopOtpMenu prompts for the OTP", () => {
      expect(shopOtpMenu()).toContain("OTP")
    })
  })

  describe("shop airtime menus", () => {
    it("shopAirtimeRecipientPrompt shows the shop name", () => {
      expect(shopAirtimeRecipientPrompt("Shop A")).toContain("Shop A")
    })

    it("shopAirtimeNetworkMenu lists all three networks", () => {
      const text = shopAirtimeNetworkMenu()
      expect(text).toContain("1. MTN")
      expect(text).toContain("2. Telecel")
      expect(text).toContain("3. AirtelTigo")
    })

    it("shopAirtimeAmountPrompt shows the min/max range for the network", () => {
      const text = shopAirtimeAmountPrompt("MTN", 1, 500)
      expect(text).toContain("MTN Airtime")
      expect(text).toContain("GHS 1 - 500")
    })

    it("shopAirtimeConfirmMenu shows pay/get amounts and formatted numbers", () => {
      const text = shopAirtimeConfirmMenu("Shop A", "MTN", "233241111111", 10.3, 10, "233245555555")
      expect(text).toContain("MTN to 0241111111")
      expect(text).toContain("Pay GHS 10.30")
      expect(text).toContain("Get GHS 10.00")
      expect(text).toContain("from 0245555555")
    })
  })

  describe("shop results-checker menus", () => {
    it("shopRcBoardMenu lists each board with a number", () => {
      const text = shopRcBoardMenu("Shop A", ["WASSCE", "BECE"])
      expect(text).toContain("1. WASSCE")
      expect(text).toContain("2. BECE")
    })

    it("shopRcQtyPrompt caps at the lower of available/max", () => {
      const text = shopRcQtyPrompt("WASSCE", 3, 10)
      expect(text).toContain("(1 - 3):")
    })

    it("shopRcQtyPrompt includes a bulk-pricing hint when provided", () => {
      const text = shopRcQtyPrompt("WASSCE", 20, 10, { minQty: 5, unitPrice: 10.5 })
      expect(text).toContain("Buy 5+ for GHS 10.50/ea")
    })

    it("shopRcConfirmMenu shows the board, quantity, total, and payment number", () => {
      const text = shopRcConfirmMenu("Shop A", "WASSCE", 2, 21, "233245555555")
      expect(text).toContain("WASSCE x 2")
      expect(text).toContain("GHS 21.00 from")
      expect(text).toContain("0245555555")
    })
  })
})
