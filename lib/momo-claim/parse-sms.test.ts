import { describe, it, expect } from "vitest";
import { parseMomoSms, passesPrefilter } from "./parse-sms";

const CASH_IN =
  "Cash In received for GHS 200.00 from JOHN DOE. Current Balance GHS 272.65 Available Balance GHS 272.65. Transaction ID: 80000000001.";

const payment = (from = "") =>
  `Payment received for GHS 3.00 from JANE DOE  Current Balance ... Reference: JANE DOE ,233000000000,2${from ? " from " + from : ""}. Transaction ID: 80000000002.`;

describe("parseMomoSms", () => {
  it("parses MTN cash in", () => {
    expect(parseMomoSms(CASH_IN)).toEqual({
      pattern: "mtn_cash_in",
      network: "MTN",
      amountPesewas: 20000,
      senderName: "JOHN DOE",
      transactionId: "80000000001",
      balancePesewas: 27265,
    });
  });

  it("parses MTN payment and labels cross-network", () => {
    const r = parseMomoSms(payment("VODAFONE"));
    expect(r).toMatchObject({
      pattern: "mtn_payment",
      network: "Telecel",
      amountPesewas: 300,
      senderName: "JANE DOE",
      transactionId: "80000000002",
      balancePesewas: null,
    });
    expect(parseMomoSms(payment("TELECEL"))?.network).toBe("Telecel");
    expect(parseMomoSms(payment("AIRTEL"))?.network).toBe("AirtelTigo");
    expect(parseMomoSms(payment("TIGO"))?.network).toBe("AirtelTigo");
    expect(parseMomoSms(payment())?.network).toBe("MTN");
  });

  it("parses telecel", () => {
    expect(
      parseMomoSms("GHS 50.00 has been received from ABENA MENSAH. Your balance is GHS 90.00. Transaction ID: 123456789"),
    ).toEqual({
      pattern: "telecel",
      network: "Telecel",
      amountPesewas: 5000,
      senderName: "ABENA MENSAH",
      transactionId: "123456789",
      balancePesewas: null,
    });
  });

  it("parses airteltigo", () => {
    expect(
      parseMomoSms("You have received GHS 50.00 from KOFI ASANTE. Your balance is GHS 90.00. Transaction ID: 987654321"),
    ).toEqual({
      pattern: "airteltigo",
      network: "AirtelTigo",
      amountPesewas: 5000,
      senderName: "KOFI ASANTE",
      transactionId: "987654321",
      balancePesewas: null,
    });
  });

  it("amount formats", () => {
    const t = (amt: string) =>
      parseMomoSms(`GHS ${amt} has been received from ABENA MENSAH. Transaction ID: 123456789`)?.amountPesewas ?? null;
    expect(t("1,200.00")).toBe(120000);
    expect(t("1,200")).toBe(120000);
    expect(t("50.")).toBe(5000);
    expect(t("0.00")).toBeNull();
    expect(t("0.10")).toBe(10);
    expect(t("19.99")).toBe(1999);
    expect(t("1.1")).toBe(110);
  });

  it("rejects txid outside 8-15 digits", () => {
    const t = (id: string) =>
      parseMomoSms(`GHS 5.00 has been received from ABENA MENSAH. Transaction ID: ${id}`);
    expect(t("1234567")).toBeNull();
    expect(t("1234567890123456")).toBeNull();
    expect(t("12345678")).not.toBeNull();
    expect(t("123456789012345")).not.toBeNull();
  });

  it("rejects sender shorter than 2 chars", () => {
    expect(parseMomoSms("GHS 5.00 has been received from A. Transaction ID: 123456789")).toBeNull();
  });

  it("first matching pattern wins", () => {
    // Matches both MTN cash in and the telecel wording; cash in comes first.
    const both =
      "Cash In received for GHS 10.00 from JOHN DOE. Current Balance GHS 1.00. GHS 99.00 has been received from OTHER PERSON. Transaction ID: 80000000009.";
    expect(parseMomoSms(both)?.pattern).toBe("mtn_cash_in");
  });

  it("parses the real MTN payment SMS (2026-11-12 shape)", () => {
    const sms =
      "Payment received for GHS 10.00 from JOHN KWAME DOE  Current Balance: GHS 1234.56 . Available Balance: GHS 1234.56. Reference: TST2345. Transaction ID: 93600000001. TRANSACTION FEE: 0.00";
    expect(parseMomoSms(sms)).toEqual({
      pattern: "mtn_payment",
      network: "MTN",
      amountPesewas: 1000,
      senderName: "JOHN KWAME DOE",
      transactionId: "93600000001",
      balancePesewas: 123456,
    });
  });

  it("reads the balance with optional colon and thousands separators", () => {
    const mk = (bal: string) =>
      `Payment received for GHS 3.00 from JANE DOE  Current Balance${bal}. Transaction ID: 80000000002.`;
    expect(parseMomoSms(mk(" GHS 272.65"))?.balancePesewas).toBe(27265);
    expect(parseMomoSms(mk(": GHS 1234.56"))?.balancePesewas).toBe(123456);
    expect(parseMomoSms(mk(":GHS 1,234.56"))?.balancePesewas).toBe(123456);
  });

  it("rejects amounts with more than 2 decimal places", () => {
    expect(
      parseMomoSms(
        "Cash In received for GHS 10.005 from JOHN DOE. Current Balance GHS 1.00. Transaction ID: 80000000003.",
      ),
    ).toBeNull();
  });

  it("returns null for unrelated text", () => {
    expect(parseMomoSms("hello")).toBeNull();
  });
});

describe("passesPrefilter", () => {
  it("is true only with both GHS and Transaction ID, case-insensitive", () => {
    expect(passesPrefilter(CASH_IN)).toBe(true);
    expect(passesPrefilter("ghs 5 transaction id 1")).toBe(true);
    expect(passesPrefilter("GHS 5 promo")).toBe(false);
    expect(passesPrefilter("Transaction ID: 1")).toBe(false);
    expect(passesPrefilter("")).toBe(false);
  });
});
