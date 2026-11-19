import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Allowed fields for package create/update (prevents mass assignment)
const ALLOWED_PACKAGE_FIELDS = ["name", "network", "size", "price", "dealer_price", "active", "description", "category"]

const COST_ROW_CAP = 1000

function serviceClient() {
  return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

/** Round half up to 2dp via the decimal string, so 4.555 gives 4.56 (Math.round(4.555 * 100) gives 455). */
function round2(n: number): number {
  const s = String(n)
  if (/e/i.test(s)) return Math.round(n * 100) / 100
  return Number(Math.round(Number(`${s}e2`)) + "e-2")
}

/** Admin-only supplier cost: GET returns { costs: { [package_id]: number } } from package_costs. Never exposed elsewhere. */
export async function GET(req: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  if (!userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const { data, error } = await serviceClient().from("package_costs").select("package_id, cost_price").limit(COST_ROW_CAP)
    // A full page cannot be proven complete: fail closed.
    if (error || !Array.isArray(data) || data.length >= COST_ROW_CAP) {
      return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
    }
    const costs: Record<string, number> = {}
    for (const row of data as Array<{ package_id: unknown; cost_price: unknown }>) {
      const c = Number(row.cost_price)
      if (row.cost_price != null && Number.isFinite(c)) costs[String(row.package_id)] = c
    }
    return NextResponse.json({ costs })
  } catch {
    console.error("[PACKAGES] cost read failed")
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  try {
    const { packageData, packageId, isUpdate } = await req.json()

    // Whitelist fields to prevent mass assignment
    const safeData = packageData
      ? Object.fromEntries(Object.entries(packageData).filter(([k]) => ALLOWED_PACKAGE_FIELDS.includes(k)))
      : null

    // cost_price is not a packages column: it goes to the admin-only package_costs table after the package write.
    // undefined = untouched; null = delete the row; number >= 0 = upsert rounded to 2dp.
    let cost: number | null | undefined
    const rawCost = packageData && typeof packageData === "object" ? (packageData as Record<string, unknown>).cost_price : undefined
    if (rawCost !== undefined) {
      if (rawCost === null || rawCost === "") {
        cost = null
      } else if (typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0) {
        cost = round2(rawCost)
      } else {
        return NextResponse.json({ error: "cost_price must be a non-negative number" }, { status: 400 })
      }
    }

    const costOnly = !!safeData && Object.keys(safeData).length === 0 && cost !== undefined && !!isUpdate && !!packageId
    if (!safeData || (Object.keys(safeData).length === 0 && !costOnly)) {
      return NextResponse.json({ error: "Package data is required" }, { status: 400 })
    }

    const ALLOWED_NETWORKS = ["MTN", "AirtelTigo", "Telecel"]
    if (safeData.network !== undefined && !ALLOWED_NETWORKS.includes(safeData.network as string)) {
      return NextResponse.json({ error: `Invalid network. Must be one of: ${ALLOWED_NETWORKS.join(", ")}` }, { status: 400 })
    }

    if (safeData.name !== undefined) {
      if (typeof safeData.name !== "string" || safeData.name.trim().length === 0) {
        return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 })
      }
      if (safeData.name.length > 200) {
        return NextResponse.json({ error: "name must be 200 characters or fewer" }, { status: 400 })
      }
    }

    if (safeData.price !== undefined) {
      if (typeof safeData.price !== "number" || !isFinite(safeData.price) || safeData.price <= 0) {
        return NextResponse.json({ error: "price must be a positive number" }, { status: 400 })
      }
    }

    if (safeData.dealer_price !== undefined) {
      if (typeof safeData.dealer_price !== "number" || !isFinite(safeData.dealer_price) || safeData.dealer_price < 0) {
        return NextResponse.json({ error: "dealer_price must be a non-negative number" }, { status: 400 })
      }
    }

    if (safeData.size !== undefined) {
      if (typeof safeData.size !== "string" || (safeData.size as string).trim().length === 0) {
        return NextResponse.json({ error: "size must be a non-empty string" }, { status: 400 })
      }
    }

    // Create admin client with service role
    const adminClient = serviceClient()

    // Runs only after the package write succeeded. Never logs the amount.
    const writeCost = async (pkgId: string): Promise<boolean> => {
      if (cost === undefined) return true
      const res =
        cost === null
          ? await adminClient.from("package_costs").delete().eq("package_id", pkgId)
          : await adminClient
              .from("package_costs")
              .upsert({ package_id: pkgId, cost_price: cost, updated_at: new Date().toISOString(), updated_by: userId ?? null }, { onConflict: "package_id" })
      if (res.error) {
        console.error("[PACKAGES] cost write failed")
        return false
      }
      return true
    }
    const costFailure = () => NextResponse.json({ error: "Package saved, but the cost could not be saved" }, { status: 500 })

    if (isUpdate && packageId) {
      // Update package
      let rows: Array<Record<string, unknown>> | null
      if (costOnly) {
        const { data, error } = await adminClient.from("packages").select("id").eq("id", packageId)
        if (error) return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
        rows = data as Array<Record<string, unknown>> | null
        if (!rows?.length) return NextResponse.json({ error: "Package not found" }, { status: 404 })
      } else {
        const { data, error } = await adminClient
          .from("packages")
          .update(safeData)
          .eq("id", packageId)
          .select()

        if (error) {
          console.error("Error updating package:", error)
          return NextResponse.json({ error: error.message }, { status: 400 })
        }
        rows = data as Array<Record<string, unknown>> | null
      }

      if (cost !== undefined) {
        if (!rows?.length) return NextResponse.json({ error: "Package not found" }, { status: 404 })
        if (!(await writeCost(String(packageId)))) return costFailure()
      }

      revalidateTag("seo-live-facts")
      return NextResponse.json({ success: true, data: rows?.[0], message: "Package updated successfully" })
    } else {
      // Create package
      const { data, error } = await adminClient
        .from("packages")
        .insert([safeData])
        .select()

      if (error) {
        console.error("Error creating package:", error)
        return NextResponse.json({ error: error.message }, { status: 400 })
      }

      if (cost !== undefined && cost !== null) {
        const newId = data?.[0]?.id
        if (!newId || !(await writeCost(String(newId)))) return costFailure()
      }

      revalidateTag("seo-live-facts")
      return NextResponse.json({ success: true, data: data?.[0], message: "Package created successfully" })
    }
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
