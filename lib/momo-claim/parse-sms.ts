// Parses MoMo confirmation SMS text forwarded from the business phone.
// Pure logic. Never log the SMS text: it contains payer names and amounts.

export type ParsedSms = {
  pattern: "mtn_cash_in" | "mtn_payment" | "telecel" | "airteltigo";
  network: "MTN" | "Telecel" | "AirtelTigo";
  amountPesewas: number;
  senderName: string;
  transactionId: string;
  balancePesewas: number | null;
};

const MTN_CASH_IN =
  /Cash\s+In\s+received\s+for\s+GHS\s+([\d,]+\.?\d*)\s+from\s+(.+?)\.\s+Current.*?Transaction\s+ID[:\s]*([\d]+)/i;
const MTN_PAYMENT =
  /Payment\s+received\s+for\s+GHS\s+([\d,]+\.?\d*)\s+from\s+(.+?)\s+Current.*?Transaction\s+ID[:\s]*([\d]+)/i;
const TELECEL =
  /GHS\s+([\d,]+\.?\d*)\s+has\s+been\s+received\s+from\s+(.+?)[\.\n].*?Transaction\s+ID[:\s]*([\d]+)/i;
const AIRTELTIGO =
  /received\s+GHS\s+([\d,]+\.?\d*)\s+from\s+(.+?)[\.\n].*?Transaction\s+ID[:\s]*([\d]+)/i;

const BALANCE = /Current\s+Balance\s*:?\s*GHS\s*([\d,]+\.?\d*)/i;

/** "1,200.5" -> 120050 without floating point. Null if not a number or more than 2 decimals. */
function toPesewas(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "");
  const [whole, frac = ""] = cleaned.split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(frac)) return null;
  const pesewas = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return Number.isSafeInteger(pesewas) ? pesewas : null;
}

export function passesPrefilter(text: string): boolean {
  return /GHS/i.test(text) && /Transaction ID/i.test(text);
}

export function parseMomoSms(text: string): ParsedSms | null {
  const candidates: Array<[ParsedSms["pattern"], RegExp]> = [
    ["mtn_cash_in", MTN_CASH_IN],
    ["mtn_payment", MTN_PAYMENT],
    ["telecel", TELECEL],
    ["airteltigo", AIRTELTIGO],
  ];

  for (const [pattern, re] of candidates) {
    const m = re.exec(text);
    if (!m) continue;

    const amountPesewas = toPesewas(m[1]);
    const senderName = m[2].trim();
    const transactionId = m[3];
    if (amountPesewas === null || amountPesewas <= 0) return null;
    if (!/^\d{8,15}$/.test(transactionId)) return null;
    if (senderName.length < 2) return null;

    let network: ParsedSms["network"] = "MTN";
    if (pattern === "mtn_payment") {
      if (/from\s+(VODAFONE|TELECEL)/i.test(text)) network = "Telecel";
      else if (/from\s+(AIRTEL|TIGO)/i.test(text)) network = "AirtelTigo";
    } else if (pattern === "telecel") network = "Telecel";
    else if (pattern === "airteltigo") network = "AirtelTigo";

    const bal = BALANCE.exec(text);
    return {
      pattern,
      network,
      amountPesewas,
      senderName,
      transactionId,
      balancePesewas: bal ? toPesewas(bal[1]) : null,
    };
  }
  return null;
}
