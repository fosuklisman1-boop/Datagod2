import { toWaPhone, buildDeliveryMessage } from "@/lib/wa-delivery-notify"

describe("toWaPhone", () => {
  it("converts a local 0XXXXXXXXX number to 233XXXXXXXXX", () => {
    expect(toWaPhone("0241234567")).toBe("233241234567")
  })

  it("leaves an already-233 number unchanged", () => {
    expect(toWaPhone("233241234567")).toBe("233241234567")
  })

  it("strips a leading + and surrounding whitespace", () => {
    expect(toWaPhone("+233241234567")).toBe("233241234567")
    expect(toWaPhone("024 123 4567")).toBe("233241234567")
  })

  it("handles empty/falsy input without throwing", () => {
    expect(toWaPhone("")).toBe("")
  })
})

describe("buildDeliveryMessage", () => {
  it("omits 'for <number>' when purchaser and recipient are the same", () => {
    const msg = buildDeliveryMessage({ purchaserPhone: "0241234567", recipientPhone: "0241234567", detail: "5GB MTN" })
    expect(msg).toContain("Your 5GB MTN order is complete")
    expect(msg).not.toContain(" for ")
  })

  it("treats differently-formatted but identical numbers as the same (no 'for')", () => {
    const msg = buildDeliveryMessage({ purchaserPhone: "0241234567", recipientPhone: "233241234567", detail: "5GB MTN" })
    expect(msg).not.toContain(" for ")
  })

  it("includes 'for <recipient>' when the beneficiary differs from the purchaser", () => {
    const msg = buildDeliveryMessage({ purchaserPhone: "0241234567", recipientPhone: "0209999999", detail: "5GB MTN" })
    expect(msg).toContain("Your 5GB MTN order for 0209999999 is complete")
  })

  it("drops the detail phrase gracefully when detail is empty", () => {
    const msg = buildDeliveryMessage({ purchaserPhone: "0241234567", recipientPhone: null, detail: "" })
    expect(msg).toContain("Your order is complete")
  })
})
