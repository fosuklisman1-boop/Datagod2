import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { badRequest, isUuid, parsePage, refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { listPendingOrderRefs, loadRefundableOrders } from "@/lib/refunds/orders"
import { evaluateEligibility } from "@/lib/refunds/eligibility"
import { defaultRefundAmount } from "@/lib/refunds/amounts"
import { ORDER_TABLES, type OrderTable } from "@/lib/refunds/types"

const PAGE_SIZE = 50

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const sp = new URL(request.url).searchParams
    const type = sp.get("type")
    if (type && !ORDER_TABLES.includes(type as OrderTable)) return badRequest("Invalid type")
    const shopId = sp.get("shopId")
    if (shopId && !isUuid(shopId)) return badRequest("Invalid shopId")
    const q = sp.get("q")
    if (q && q.length > 100) return badRequest("Search term too long")
    const page = parsePage(sp.get("page"), 100)
    if (page === null) return badRequest("Invalid page")
    const db = refundDb()

    const refs = await listPendingOrderRefs(db, {
      table: (type as OrderTable | null) || undefined,
      shopId: shopId || undefined,
      q: q || undefined,
      pageSize: PAGE_SIZE,
      page,
    })
    const orders = await loadRefundableOrders(db, refs)
    const position = new Map(refs.map((r, i) => [`${r.table}:${r.id}`, i]))
    orders.sort((a, b) => (position.get(`${a.table}:${a.id}`) ?? 0) - (position.get(`${b.table}:${b.id}`) ?? 0))

    const rows = orders.map((o) => ({
      order: o,
      eligibility: evaluateEligibility({
        orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, hasActiveRefund: o.evidence.hasActiveRefund,
        dispatchOutcome: o.evidence.dispatchOutcome, trackingStatuses: o.evidence.trackingStatuses,
        externalOrderId: o.evidence.externalOrderId,
      }),
      defaultAmount: defaultRefundAmount(o.paid, o.gatewayFee),
    }))
    return NextResponse.json({ rows, page, pageSize: PAGE_SIZE })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
