import { describe, it, expect } from "vitest";
import {
  classifyFailureReason,
  classifyMessage,
  FAILURE_REASON_LABELS,
} from "./failure-reason";
import { FAILURE_REASON_FIXTURES } from "./failure-reason.fixtures";

describe("classifyFailureReason", () => {
  it.each(FAILURE_REASON_FIXTURES.map((f, i) => [i, f] as const))(
    "fixture %i",
    (_i, f) => {
      expect(classifyFailureReason(f.input)).toBe(f.expected);
    }
  );

  it("abandoned status wins over a balance message", () => {
    expect(
      classifyFailureReason({ status: "abandoned", mtnOrderId: null, message: "Insufficient balance" })
    ).toBe("outcome_unknown");
  });

  it("UNKNOWN_ order id wins over message", () => {
    expect(
      classifyFailureReason({ status: "failed", mtnOrderId: "UNKNOWN_1", message: "rate limit" })
    ).toBe("outcome_unknown");
  });

  it("matching is case-insensitive", () => {
    expect(
      classifyFailureReason({ status: "failed", mtnOrderId: null, message: "INSUFFICIENT BALANCE" })
    ).toBe("out_of_balance");
  });

  it("reversed is never a failure reason", () => {
    expect(
      classifyFailureReason({ status: "reversed", mtnOrderId: null, message: "not enabled on mtn" })
    ).toBe("none");
  });

  it("has a label for every reason", () => {
    const reasons = new Set(FAILURE_REASON_FIXTURES.map((f) => f.expected));
    for (const r of reasons) expect(FAILURE_REASON_LABELS[r]).toBeTruthy();
    expect(Object.keys(FAILURE_REASON_LABELS)).toHaveLength(9);
  });
});

describe("classifyMessage", () => {
  it("returns the keyword reason, case-insensitive", () => {
    expect(classifyMessage("Insufficient balance")).toBe("out_of_balance");
    expect(classifyMessage("RATE LIMIT exceeded")).toBe("rate_limited");
    expect(classifyMessage("No active bundle for size")).toBe("no_bundle");
  });

  it("returns null when no keyword matches (never 'rejected')", () => {
    expect(classifyMessage("socket hang up")).toBeNull();
    expect(classifyMessage("")).toBeNull();
    expect(classifyMessage(null)).toBeNull();
  });
});
