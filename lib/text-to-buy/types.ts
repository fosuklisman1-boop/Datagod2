export type Line = "main" | "shop"
export type Service = "data"
export type NetworkHint = "MTN" | "Telecel" | "AT" | "AT-iShare" | "AT-BigTime"
export type Keyword = "PRICES" | "AGAIN" | "STATUS" | "HELP" | "YES"
export type ReadResult =
  | { kind: "order"; service: Service; sizeMb: number; networkHint: NetworkHint | null; recipient: string | null; bare: boolean }
  | { kind: "price_query"; service: Service; sizeMb: number | null; networkHint: NetworkHint | null }
  | { kind: "keyword"; keyword: Keyword }
  | { kind: "ask"; question: string } // AI only
  | { kind: "not_order" }
  | { kind: "unknown" } // rules only: hand to the AI
export type Outcome =
  | "prompted" | "asked" | "price_answer" | "keyword" | "late" | "limited" | "open_order"
  | "not_order" | "unavailable" | "blocked" | "duplicate" | "off" | "error"
