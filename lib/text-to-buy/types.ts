export type Line = "main" | "shop"
export type Service = "data" | "airtime" | "results_checker"
export type OrderTable = "ussd_orders" | "airtime_orders" | "results_checker_orders"
/** The order table each service writes to. A link row's (service, order_table) pair must always agree with this. */
export const ORDER_TABLE_OF: Record<Service, OrderTable> = {
  data: "ussd_orders",
  airtime: "airtime_orders",
  results_checker: "results_checker_orders",
}
export type NetworkHint = "MTN" | "Telecel" | "AT" | "AT-iShare" | "AT-BigTime"
export type Keyword = "PRICES" | "AGAIN" | "STATUS" | "HELP" | "YES"
// Until the per-service read union lands, both order-shaped members are data reads: the literal keeps them honest.
export type ReadResult =
  | { kind: "order"; service: "data"; sizeMb: number; networkHint: NetworkHint | null; recipient: string | null; bare: boolean }
  | { kind: "price_query"; service: "data"; sizeMb: number | null; networkHint: NetworkHint | null }
  | { kind: "keyword"; keyword: Keyword }
  | { kind: "ask"; question: string } // AI only
  | { kind: "not_order" }
  | { kind: "unknown" } // rules only: hand to the AI
export type OrderRead = Extract<ReadResult, { kind: "order" }>
export type Outcome =
  | "prompted" | "asked" | "price_answer" | "keyword" | "late" | "limited" | "open_order"
  | "not_order" | "unavailable" | "blocked" | "duplicate" | "off" | "error"
