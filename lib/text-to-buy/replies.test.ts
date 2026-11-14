import { describe, it, expect } from "vitest"
import { calculateSegments } from "@/lib/sms/segments"
import {
  MAX_REPLY_CHARS,
  type QuoteInput,
  quoteReply,
  unpaidReply,
  deliveredGiftReply,
  paidNotDeliveredReply,
  repricedReply,
  lateReply,
  limitedReply,
  openOrderReply,
  notUnderstoodReply,
  unavailableReply,
  priceListReply,
  priceAnswerReply,
  statusReply,
  helpReply,
  wrongNumberReply,
  formatGhs,
  containsMoney,
  safeAiQuestion,
  fitOneSegment,
  amountToken,
  airtimeQuoteReply,
  airtimeGiftDeliveredReply,
  delayedReply,
  airtimeLimitsReply,
  airtimeOffReply,
  airtimeWrongNumberReply,
  airtimeNetworkQuestion,
  placedNeutralReply,
} from "./replies"

const oneSegment = (s: string) => {
  const r = calculateSegments(s)
  expect([r.encoding, r.segments]).toEqual(["gsm7", 1])
}

describe("airtime copy", () => {
  const q = { networkLabel: "MTN", recipientLocal: "0200000102", payGhs: 10, getsGhs: 9.52, feeOnTop: false, payerNetwork: "MTN" as const }
  it("amountToken", () => {
    expect(amountToken(10)).toBe("10")
    expect(amountToken(10.5)).toBe("10.50")
    expect(amountToken(0.5)).toBe("0.50")
  })
  it("quote", () =>
    expect(airtimeQuoteReply(q)).toBe("MTN airtime for 0200000102: you pay GHS 10.00, they get GHS 9.52. Approve the MoMo prompt now. No prompt? Dial *170#, 6, 3."))
  it("quote, fee on top", () =>
    expect(airtimeQuoteReply({ ...q, feeOnTop: true })).toContain("you pay GHS 10.00 + MoMo charge, they get GHS 9.52."))
  it("quote, unknown payer has no tip", () =>
    expect(airtimeQuoteReply({ ...q, payerNetwork: "UNKNOWN" })).toBe("MTN airtime for 0200000102: you pay GHS 10.00, they get GHS 9.52. Approve the MoMo prompt now."))
  it("worst case is one segment and keeps both amounts, the recipient and the approve line", () => {
    const t = airtimeQuoteReply({ networkLabel: "Telecel", recipientLocal: "0551234567", payGhs: 9999.99, getsGhs: 9999.99, feeOnTop: true, payerNetwork: "TELECEL" })
    oneSegment(t)
    expect(t.match(/9,999\.99/g)).toHaveLength(2)
    expect(t).toContain("0551234567")
    expect(t).toContain("Approve the MoMo prompt now.")
  })
  it("fixed strings", () => {
    expect(airtimeGiftDeliveredReply("airtime 10", "0200000102")).toBe("Airtime sent to 0200000102. Text airtime 10 to buy again.")
    expect(delayedReply()).toBe("We received your payment. Delivery is delayed; we are on it and will update you.")
    expect(airtimeLimitsReply(1, 500)).toBe("Airtime is GHS 1 to 500. Text e.g. airtime 10.")
    expect(airtimeOffReply("MTN")).toBe("MTN airtime is not available now.")
    expect(airtimeWrongNumberReply()).toBe("That phone number is not valid. Text e.g. airtime 10 0241234567.")
    expect(airtimeNetworkQuestion()).toBe("Which network is that number on? 1) MTN 2) Telecel 3) AT")
    expect(placedNeutralReply()).toBe("Your order was placed. Approve the MoMo prompt if you get one.")
  })
  it("every fixed string is one GSM-7 segment", () => {
    for (const s of [
      airtimeGiftDeliveredReply("airtime 9999.99", "0200000102"), delayedReply(), airtimeLimitsReply(1, 500), airtimeOffReply("Telecel"),
      airtimeWrongNumberReply(), airtimeNetworkQuestion(), placedNeutralReply(),
    ]) oneSegment(s)
  })
  it("notUnderstoodReply and helpReply name only the enabled services", () => {
    const stage1 = "To buy data, text the size e.g. 5GB. For someone else add the number: 5GB 0241234567. Text PRICES for the list."
    expect(notUnderstoodReply()).toBe(stage1)
    expect(notUnderstoodReply({})).toBe(stage1)
    expect(notUnderstoodReply({ airtime: false, resultsChecker: false })).toBe(stage1)
    expect(notUnderstoodReply({ airtime: true, resultsChecker: true })).toBe(
      "Text 5GB for data, airtime 10 for airtime, or 2 wassce for checkers. For someone else add the number: 5GB 0241234567. Text PRICES for the list.",
    )
    expect(notUnderstoodReply({ airtime: true })).toBe(
      "Text 5GB for data or airtime 10 for airtime. For someone else add the number: 5GB 0241234567. Text PRICES for the list.",
    )
    expect(notUnderstoodReply({ resultsChecker: true })).toBe(
      "Text 5GB for data or 2 wassce for checkers. For someone else add the number: 5GB 0241234567. Text PRICES for the list.",
    )
    for (const a of [true, false]) for (const r of [true, false]) {
      expect(helpReply({ airtime: a, resultsChecker: r })).toBe(notUnderstoodReply({ airtime: a, resultsChecker: r }))
      oneSegment(notUnderstoodReply({ airtime: a, resultsChecker: r }))
    }
  })
})

const base: QuoteInput = {
  size: "5GB",
  networkLabel: "MTN",
  recipientLocal: "0241234567",
  amountGhs: 23,
  feeOnTop: false,
  payerNetwork: "MTN",
}
const worst: QuoteInput = {
  size: "100GB",
  networkLabel: "Telecel",
  recipientLocal: "0551234567",
  amountGhs: 9999.99,
  feeOnTop: true,
  payerNetwork: "TELECEL",
}

describe("exact copy", () => {
  it("MAX_REPLY_CHARS is 160", () => expect(MAX_REPLY_CHARS).toBe(160))
  it("quote, MTN payer", () =>
    expect(quoteReply(base)).toBe(
      "5GB MTN for 0241234567, GHS 23.00. Approve the MoMo prompt now. No prompt? Dial *170#, 6, 3. Next time just text 5GB",
    ))
  it("quote, fee on top", () =>
    expect(quoteReply({ ...base, feeOnTop: true })).toContain("GHS 23.00 + MoMo charge. Approve"))
  it("quote, Telecel payer tip", () =>
    expect(quoteReply({ ...base, payerNetwork: "TELECEL" })).toContain("No prompt? Dial *110#, 4, 2."))
  it("quote, AT payer tip", () =>
    expect(quoteReply({ ...base, payerNetwork: "AT" })).toContain("No prompt? Dial *110#, 6."))
  it("quote, unknown payer has no tip", () =>
    expect(quoteReply({ ...base, payerNetwork: "UNKNOWN" })).toBe(
      "5GB MTN for 0241234567, GHS 23.00. Approve the MoMo prompt now. Next time just text 5GB",
    ))
  it("unpaid", () =>
    expect(unpaidReply("5GB")).toBe(
      "Payment didn't go through. Reply YES to try again, or text 5GB. If you already approved, ignore this.",
    ))
  it("delivered gift", () =>
    expect(deliveredGiftReply("5GB", "0551234567")).toBe("5GB sent to 0551234567. Text 5GB to buy again."))
  it("paid not delivered", () =>
    expect(paidNotDeliveredReply()).toBe(
      "We received your payment but delivery is delayed. We are working on it and will update you. No need to pay again.",
    ))
  it("repriced", () =>
    expect(repricedReply(23)).toBe("Total is now GHS 23.00. Approve the MoMo prompt or ignore it."))
  it("late", () =>
    expect(lateReply()).toBe("Your message arrived late so we did not charge you. Please text again."))
  it("limited", () => expect(limitedReply()).toBe("Too many requests. Please try again in 1 hour."))
  it("open order", () =>
    expect(openOrderReply()).toBe("Approve the MoMo prompt for your first order, or wait 5 minutes and text again."))
  it("not understood", () =>
    expect(notUnderstoodReply()).toBe(
      "To buy data, text the size e.g. 5GB. For someone else add the number: 5GB 0241234567. Text PRICES for the list.",
    ))
  it("help equals not understood", () => expect(helpReply()).toBe(notUnderstoodReply()))
  it("wrong number", () =>
    expect(wrongNumberReply()).toBe(
      "That phone number is not valid. Text the size and a 10-digit number, e.g. 5GB 0241234567.",
    ))
})

describe("chosen wording", () => {
  it("price answer", () => expect(priceAnswerReply("5GB", "MTN", 23)).toBe("MTN 5GB is GHS 23.00. Text 5GB to buy."))
  it("status variants", () => {
    expect(statusReply("none")).toBe("No recent order found. To buy data, text the size e.g. 5GB.")
    expect(statusReply("awaiting_payment", "5GB")).toBe("Your 5GB order is waiting for payment. Approve the MoMo prompt.")
    expect(statusReply("processing", "5GB")).toBe("Your 5GB order is paid and being delivered. Please wait a few minutes.")
    expect(statusReply("delivered", "5GB")).toBe("Your 5GB order was delivered.")
    expect(statusReply("failed", "5GB")).toBe("Your 5GB order was not completed. Text 5GB to try again.")
  })
  it("status without a size stays sensible", () => {
    expect(statusReply("processing")).toBe("Your order is paid and being delivered. Please wait a few minutes.")
    expect(statusReply("failed")).toBe("Your order was not completed. Text the size to try again.")
  })
  it("unavailable lists nearest sizes", () =>
    expect(unavailableReply("MTN", [{ size: "4GB", priceGhs: 18 }, { size: "6GB", priceGhs: 27 }])).toBe(
      "That size is not available on MTN. Nearest: 4GB GHS 18.00, 6GB GHS 27.00. Text one of these sizes.",
    ))
  it("unavailable with nothing nearby", () =>
    expect(unavailableReply("MTN", [])).toBe("That size is not available on MTN. Text PRICES for the list."))
  it("formatGhs", () => {
    expect(formatGhs(23)).toBe("GHS 23.00")
    expect(formatGhs(4.5)).toBe("GHS 4.50")
    expect(formatGhs(1234.5)).toBe("GHS 1,234.50")
    expect(formatGhs(9999.99)).toBe("GHS 9,999.99")
  })
})

describe("one segment", () => {
  const all = () => [
    quoteReply(worst),
    quoteReply({ ...worst, payerNetwork: "AT" }),
    unpaidReply("100GB"),
    deliveredGiftReply("100GB", "0551234567"),
    paidNotDeliveredReply(),
    repricedReply(99999.99),
    lateReply(),
    limitedReply(),
    openOrderReply(),
    notUnderstoodReply(),
    helpReply(),
    wrongNumberReply(),
    priceAnswerReply("100GB", "Telecel", 9999.99),
    statusReply("none"),
    statusReply("awaiting_payment", "100GB"),
    statusReply("processing", "100GB"),
    statusReply("delivered", "100GB"),
    statusReply("failed", "100GB"),
    unavailableReply("Telecel", [{ size: "100GB", priceGhs: 9999.99 }, { size: "200GB", priceGhs: 9999.99 }, { size: "300GB", priceGhs: 9999.99 }]),
    priceListReply("Telecel", Array.from({ length: 30 }, (_, i) => ({ size: `${i + 1}GB`, priceGhs: 9999.99 }))),
  ]
  it("every template fits one GSM-7 segment at worst case", () => {
    for (const s of all()) {
      const r = calculateSegments(s)
      expect(r.encoding).toBe("gsm7")
      expect(r.segments).toBe(1)
    }
  })
  it("quote keeps price, recipient and approve line at worst case", () => {
    const q = quoteReply({ ...worst })
    expect(q).toContain("GHS 9,999.99")
    expect(q).toContain("0551234567")
    expect(q).toContain("Approve the MoMo prompt now.")
  })
  it("quote drops the hint, then the tip, before the approve line", () => {
    const noHint = quoteReply({ ...worst, size: `${"1".repeat(20)}GB` })
    expect(calculateSegments(noHint).segments).toBe(1)
    expect(noHint).not.toContain("Next time")
    expect(noHint).toContain("No prompt? Dial *110#, 4, 2.")

    const noTip = quoteReply({ ...worst, size: `${"1".repeat(50)}GB` })
    expect(calculateSegments(noTip).segments).toBe(1)
    expect(noTip).not.toContain("Next time")
    expect(noTip).not.toContain("No prompt?")
    expect(noTip).toContain("Approve the MoMo prompt now.")
    expect(noTip).toContain("GHS 9,999.99")
    expect(noTip).toContain("0551234567")
  })
  it("fitOneSegment joins with a space and drops from the end", () => {
    expect(fitOneSegment(["a", "b"])).toBe("a b")
    const out = fitOneSegment(["a".repeat(100), "b".repeat(50), "c".repeat(50)])
    expect(out).toBe(`${"a".repeat(100)} ${"b".repeat(50)}`.slice(0, 160))
    expect(out.length).toBeLessThanOrEqual(160)
    expect(out).not.toContain("c")
  })
  it("fitOneSegment hard-caps a first part that is too long", () => {
    expect(fitOneSegment(["x".repeat(300)]).length).toBe(160)
  })
  it("priceListReply numbers items and truncates to fit", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ size: `${i + 1}GB`, priceGhs: (i + 1) * 4.5 }))
    const s = priceListReply("MTN", items)
    expect(calculateSegments(s).segments).toBe(1)
    expect(s).toMatch(/^MTN: 1\) 1GB GHS 4\.50 2\) 2GB GHS 9\.00/)
    expect(s.endsWith(" ")).toBe(false)
    // whole items only: the last item present is complete
    expect(s).toMatch(/\d+\) \d+GB GHS [\d,]+\.\d{2}$/)
  })
  it("priceListReply with a short list keeps every item", () => {
    expect(priceListReply("AT", [{ size: "1GB", priceGhs: 4 }, { size: "2GB", priceGhs: 8 }])).toBe(
      "AT: 1) 1GB GHS 4.00 2) 2GB GHS 8.00",
    )
  })
})

describe("containsMoney", () => {
  it.each([
    "GHS 5", "ghc5", "5 cedis", "₵5", "50 pesewas", "it costs 12.50",
    "GHS20", "20ghs", "twenty cedis", "5 GHC", "12,50", "12.5", "1,200", "is 20, ok?",
    "$20", "USD 5", "GH 20", "5GB costs 20 only", "12.50 GBP", "twenty only for 5GB",
    "12.50 MBs", "call 0241234567",
    "the price (20)", "5GB for (20)", "costs 20)", "(20)",
  ])("true: %s", (t) => expect(containsMoney(t)).toBe(true))
  it.each([
    "Which size? 1) 1GB 2) 2GB 3) 5GB",
    "1) 1GB 2) 2GB",
    "Which number should receive the 2GB?",
    "Do you want 1.5GB?",
    "1.5GB or 500MB?",
    "Which one? 1) AT iShare 5GB 2) AT BigTime 5GB",
  ])(
    "false: %s",
    (t) => expect(containsMoney(t)).toBe(false),
  )
})

describe("safeAiQuestion", () => {
  it("passes a clean short question", () =>
    expect(safeAiQuestion("Which number should receive the 2GB?")).toBe("Which number should receive the 2GB?"))
  it("replaces a reply that states a price", () =>
    expect(safeAiQuestion("5GB is GHS 20, shall I proceed?")).toBe(notUnderstoodReply()))
  it("replaces a reply with a bare amount and no currency word", () => {
    expect(safeAiQuestion("5GB is 20, shall I proceed?")).toBe(notUnderstoodReply())
    expect(safeAiQuestion("twenty only for 5GB, ok?")).toBe(notUnderstoodReply())
  })
  it("replaces a reply that echoes a phone number", () =>
    expect(safeAiQuestion("Send to 0241234567?")).toBe(notUnderstoodReply()))
  it("replaces a reply longer than one segment", () =>
    expect(safeAiQuestion("x".repeat(161))).toBe(notUnderstoodReply()))
  it("replaces a non-GSM-7 reply", () =>
    expect(safeAiQuestion("Which size? ✨")).toBe(notUnderstoodReply()))
})
