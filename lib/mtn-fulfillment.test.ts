import {
  normalizePhoneNumber,
  isValidPhoneFormat,
  getNetworkFromPhone,
  validatePhoneNetworkMatch,
} from "@/lib/mtn-fulfillment"

describe("MTN Fulfillment Service", () => {
  describe("normalizePhoneNumber", () => {
    it("should handle 10-digit format with 0 prefix", () => {
      expect(normalizePhoneNumber("0241234567")).toBe("0241234567")
    })

    it("should add 0 prefix to 9-digit numbers", () => {
      expect(normalizePhoneNumber("241234567")).toBe("0241234567")
    })

    it("should convert country code format", () => {
      expect(normalizePhoneNumber("233241234567")).toBe("0241234567")
    })

    it("should remove dashes and spaces", () => {
      expect(normalizePhoneNumber("024-123-4567")).toBe("0241234567")
      expect(normalizePhoneNumber("024 123 4567")).toBe("0241234567")
    })

    it("should remove plus sign", () => {
      expect(normalizePhoneNumber("+233241234567")).toBe("0241234567")
    })
  })

  describe("isValidPhoneFormat", () => {
    it("should accept valid MTN numbers", () => {
      expect(isValidPhoneFormat("0241234567")).toBe(true)
      expect(isValidPhoneFormat("0251234567")).toBe(true)
      expect(isValidPhoneFormat("0531234567")).toBe(true)
    })

    it("should accept 9-digit format", () => {
      expect(isValidPhoneFormat("241234567")).toBe(true)
    })

    it("should accept country code format", () => {
      expect(isValidPhoneFormat("233241234567")).toBe(true)
    })

    it("should reject invalid formats", () => {
      expect(isValidPhoneFormat("024123")).toBe(false) // Too short
      expect(isValidPhoneFormat("024123456789")).toBe(false) // Too long
      expect(isValidPhoneFormat("abc123456")).toBe(false) // Non-numeric
    })
  })

  describe("getNetworkFromPhone", () => {
    it("should detect MTN numbers", () => {
      expect(getNetworkFromPhone("0241234567")).toBe("MTN")
      expect(getNetworkFromPhone("0251234567")).toBe("MTN")
      expect(getNetworkFromPhone("0531234567")).toBe("MTN")
      expect(getNetworkFromPhone("0541234567")).toBe("MTN")
      expect(getNetworkFromPhone("0551234567")).toBe("MTN")
      expect(getNetworkFromPhone("0591234567")).toBe("MTN")
    })

    it("should detect Telecel numbers", () => {
      expect(getNetworkFromPhone("0201234567")).toBe("Telecel")
      expect(getNetworkFromPhone("0501234567")).toBe("Telecel")
    })

    it("should detect AirtelTigo numbers", () => {
      expect(getNetworkFromPhone("0261234567")).toBe("AirtelTigo")
      expect(getNetworkFromPhone("0271234567")).toBe("AirtelTigo")
      expect(getNetworkFromPhone("0561234567")).toBe("AirtelTigo")
      expect(getNetworkFromPhone("0571234567")).toBe("AirtelTigo")
    })

    it("should return null for invalid numbers", () => {
      expect(getNetworkFromPhone("0301234567")).toBe(null)
      expect(getNetworkFromPhone("1234567890")).toBe(null)
    })
  })

  describe("validatePhoneNetworkMatch", () => {
    it("should match valid MTN numbers", () => {
      expect(validatePhoneNetworkMatch("0241234567", "MTN")).toBe(true)
      expect(validatePhoneNetworkMatch("241234567", "MTN")).toBe(true)
    })

    it("should reject mismatched networks", () => {
      expect(validatePhoneNetworkMatch("0201234567", "MTN")).toBe(false) // Telecel
      expect(validatePhoneNetworkMatch("0261234567", "MTN")).toBe(false) // AirtelTigo
    })

    it("should work across different formats", () => {
      expect(validatePhoneNetworkMatch("233241234567", "MTN")).toBe(true)
      expect(validatePhoneNetworkMatch("024-123-4567", "MTN")).toBe(true)
    })
  })
})
