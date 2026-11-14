import type { AirtimeNetwork } from "@/lib/airtime-pricing"

export type Line = "main" | "shop"
export type Service = "data" | "airtime" | "results_checker"
export type OrderTable = "ussd_orders" | "airtime_orders" | "results_checker_orders" | "ussd_shop_orders"
const MAIN_ORDER_TABLE: Record<Service, OrderTable> = {
  data: "ussd_orders",
  airtime: "airtime_orders",
  results_checker: "results_checker_orders",
}
/**
 * The order table a (line, service) writes to. A link row's (service, order_table) pair must always agree with this.
 * The shop line sells data only for now: shop airtime and results checkers are Stage 3c, so they throw rather than guess.
 */
export function orderTableFor(line: Line, service: Service): OrderTable {
  if (line === "main") return MAIN_ORDER_TABLE[service]
  if (service === "data") return "ussd_shop_orders"
  throw new Error(`text-to-buy: the shop line has no ${service} order table yet`)
}
/** True when (service, orderTable) is a pair some line writes. Never throws; for validating stored link rows. */
export function isKnownOrderPair(service: string, orderTable: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(MAIN_ORDER_TABLE, service)) return false
  return MAIN_ORDER_TABLE[service as Service] === orderTable || (service === "data" && orderTable === "ussd_shop_orders")
}
export type NetworkHint = "MTN" | "Telecel" | "AT" | "AT-iShare" | "AT-BigTime"
export type Keyword = "PRICES" | "AGAIN" | "STATUS" | "HELP" | "YES"
export type { AirtimeNetwork }
export type ExamBoardWord = "WASSCE" | "BECE" | "NOVDEC"
export type OrderRead =
  | { kind: "order"; service: "data"; sizeMb: number; networkHint: NetworkHint | null; recipient: string | null; bare: boolean }
  | { kind: "order"; service: "airtime"; amountGhs: number; networkHint: AirtimeNetwork | null; recipient: string | null }
  | { kind: "order"; service: "results_checker"; board: ExamBoardWord | null; quantity: number } // Task 8 uses it
// Only data has a price answer: no airtime or voucher prices are ever read out by text.
export type ReadResult =
  | OrderRead
  | { kind: "price_query"; service: "data"; sizeMb: number | null; networkHint: NetworkHint | null }
  | { kind: "keyword"; keyword: Keyword }
  // AI only; awaitBoard: the question was "how many checkers", for this board; awaitAmount: it was "how much airtime"
  | { kind: "ask"; question: string; awaitBoard?: ExamBoardWord; awaitAmount?: { network: AirtimeNetwork | null } }
  | { kind: "not_order" }
  | { kind: "unknown" } // rules only: hand to the AI
export type Outcome =
  | "prompted" | "asked" | "price_answer" | "keyword" | "late" | "limited" | "open_order"
  | "not_order" | "unavailable" | "blocked" | "duplicate" | "off" | "error"
