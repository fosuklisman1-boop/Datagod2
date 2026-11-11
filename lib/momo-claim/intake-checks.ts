import type { ParsedSms } from "./parse-sms";

export type IntakeFlag = "txid_regression" | "balance_repeat" | "above_max";

export type IntakeState = {
  newestTxid: string | null;
  balanceSeenOnOtherTxid: boolean;
  maxSentPesewas: number;
  regressionThreshold: number;
};

/**
 * Pure fraud checks run on every parsed SMS before any auto-credit.
 * Flags are returned in a fixed order: txid_regression, balance_repeat, above_max.
 * Transaction ids are 11-15 digits, so compare as BigInt, never Number.
 */
export function intakeFlags(sms: ParsedSms, state: IntakeState): IntakeFlag[] {
  const flags: IntakeFlag[] = [];

  if (state.newestTxid !== null) {
    const drop = BigInt(state.newestTxid) - BigInt(sms.transactionId);
    if (drop > BigInt(state.regressionThreshold)) flags.push("txid_regression");
  }
  if (state.balanceSeenOnOtherTxid) flags.push("balance_repeat");
  if (sms.amountPesewas > state.maxSentPesewas) flags.push("above_max");

  return flags;
}
