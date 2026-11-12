export interface SupportOrder {
  source: "order" | "shop_order"
  id: string
  reference: string | null
  beneficiary: string | null
  network: string | null
  size: string | null
  price: number | null
  status: string | null
  created_at: string | null
  shop_name: string | null
}

/** Fields of `orders` the mapper reads. */
export interface OrdersRow {
  id: string
  network: string | null
  size: string | number | null
  price: number | string | null
  status: string | null
  phone_number: string | null
  order_code: string | null
  created_at: string | null
}

/** Fields of `shop_orders` the mapper reads. */
export interface ShopOrdersRow {
  id: string
  customer_phone: string | null
  network: string | null
  volume_gb: number | string | null
  total_price: number | string | null
  order_status: string | null
  reference_code: string | null
  created_at: string | null
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

/** `orders.size` is stored as a bare number of GB; never double a unit already present. */
function gb(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null
  const s = String(v).trim()
  return /[a-z]/i.test(s) ? s : `${s}GB`
}

export function fromOrderRow(row: OrdersRow): SupportOrder {
  return {
    source: "order",
    id: row.id,
    reference: row.order_code,
    beneficiary: row.phone_number,
    network: row.network,
    size: gb(row.size),
    price: toNumber(row.price),
    status: row.status,
    created_at: row.created_at,
    shop_name: null,
  }
}

export function fromShopOrderRow(row: ShopOrdersRow, shopName: string | null): SupportOrder {
  return {
    source: "shop_order",
    id: row.id,
    reference: row.reference_code,
    beneficiary: row.customer_phone,
    network: row.network,
    size: gb(row.volume_gb),
    price: toNumber(row.total_price),
    status: row.order_status,
    created_at: row.created_at,
    shop_name: shopName,
  }
}

/** Legacy `complaints.order_details`: {network, package, phone, amount, date, orderRefId, type}. */
export function fromLegacyOrderDetails(details: unknown): SupportOrder | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null
  const d = details as Record<string, unknown>
  const ref = str(d.orderRefId)
  return {
    source: "order",
    id: ref ?? "",
    reference: ref,
    beneficiary: str(d.phone),
    network: str(d.network),
    size: str(d.package),
    price: toNumber(d.amount),
    status: null,
    created_at: str(d.date),
    shop_name: null,
  }
}
