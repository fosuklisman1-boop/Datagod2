import { describe, it, expect } from "vitest";
import { intakeFlags, type IntakeState } from "./intake-checks";
import type { ParsedSms } from "./parse-sms";

function sms(over: Partial<ParsedSms> = {}): ParsedSms {
  return {
    pattern: "mtn_cash_in",
    network: "MTN",
    amountPesewas: 1000,
    senderName: "KWAME MENSAH",
    transactionId: "80057000000",
    balancePesewas: 5000,
    ...over,
  };
}

function state(over: Partial<IntakeState> = {}): IntakeState {
  return {
    newestTxid: "80057000000",
    balanceSeenOnOtherTxid: false,
    maxSentPesewas: 100000,
    regressionThreshold: 1_000_000,
    ...over,
  };
}

describe("intakeFlags", () => {
  it("flags txid_regression when 57M lower than newest", () => {
    expect(intakeFlags(sms({ transactionId: "80000000001" }), state())).toEqual(["txid_regression"]);
  });
  it("does not flag when lower by 999,999", () => {
    expect(intakeFlags(sms({ transactionId: String(80057000000 - 999999) }), state())).toEqual([]);
  });
  it("does not flag when lower by exactly the threshold", () => {
    expect(intakeFlags(sms({ transactionId: String(80057000000 - 1000000) }), state())).toEqual([]);
  });
  it("flags when lower by threshold + 1", () => {
    expect(intakeFlags(sms({ transactionId: String(80057000000 - 1000001) }), state())).toEqual(["txid_regression"]);
  });
  it("does not flag when higher", () => {
    expect(intakeFlags(sms({ transactionId: "80058000000" }), state())).toEqual([]);
  });
  it("no regression flag when newestTxid is null", () => {
    expect(intakeFlags(sms({ transactionId: "1" }), state({ newestTxid: null }))).toEqual([]);
  });
  it("compares 15-digit txids exactly with BigInt", () => {
    const flags = intakeFlags(
      sms({ transactionId: "900000000000001" }),
      state({ newestTxid: "900000000000003", regressionThreshold: 2 }),
    );
    expect(flags).toEqual([]);
    const flags2 = intakeFlags(
      sms({ transactionId: "900000000000001" }),
      state({ newestTxid: "900000000000003", regressionThreshold: 1 }),
    );
    expect(flags2).toEqual(["txid_regression"]);
  });
  it("flags balance_repeat", () => {
    expect(intakeFlags(sms(), state({ balanceSeenOnOtherTxid: true }))).toEqual(["balance_repeat"]);
  });
  it("flags above_max strictly greater only", () => {
    expect(intakeFlags(sms({ amountPesewas: 100001 }), state())).toEqual(["above_max"]);
    expect(intakeFlags(sms({ amountPesewas: 100000 }), state())).toEqual([]);
  });
  it("returns all flags in fixed order", () => {
    expect(
      intakeFlags(
        sms({ transactionId: "80000000001", amountPesewas: 999999 }),
        state({ balanceSeenOnOtherTxid: true }),
      ),
    ).toEqual(["txid_regression", "balance_repeat", "above_max"]);
  });
});
