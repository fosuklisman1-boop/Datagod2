import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// POST: Update a user's role (Admin only)
export async function POST(request: NextRequest) {
    try {
        const authHeader = request.headers.get("Authorization")
        if (!authHeader?.startsWith("Bearer ")) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const token = authHeader.slice(7)
        const { data: { user }, error: authError } = await supabase.auth.getUser(token)

        if (authError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Verify requesting user is an admin
        const adminRole = user.user_metadata?.role
        if (adminRole !== "admin") {
            return NextResponse.json({ error: "Admin access required" }, { status: 403 })
        }

        const body = await request.json()
        const { userId, newRole } = body

        if (!userId || !newRole) {
            return NextResponse.json({ error: "Missing userId or newRole" }, { status: 400 })
        }

        // Validate role
        const validRoles = ["user", "admin", "sub_agent", "dealer"]
        if (!validRoles.includes(newRole)) {
            return NextResponse.json({ error: `Invalid role. Must be one of: ${validRoles.join(", ")}` }, { status: 400 })
        }

        // Get target user's current shop info
        const { data: targetShop, error: shopError } = await supabase
            .from("user_shops")
            .select("id, parent_shop_id")
            .eq("user_id", userId)
            .single()

        // If upgrading to 'dealer', check if user is a sub-agent (has parent_shop_id)
        if (newRole === "dealer" && targetShop?.parent_shop_id) {
            return NextResponse.json(
                { error: "Sub-agents cannot be upgraded to Dealers. They must be independent users (not linked to a parent shop)." },
                { status: 400 }
            )
        }

        // Update the user's role in the users table
        const { error: updateError } = await supabase
            .from("users")
            .update({ role: newRole })
            .eq("id", userId)

        if (updateError) {
            console.error("[UPDATE-ROLE] Error updating user role:", updateError)
            return NextResponse.json({ error: "Failed to update user role" }, { status: 500 })
        }

        // If upgrading to dealer, adjust profit margins to maintain selling prices
        if (newRole === "dealer" && targetShop) {
            console.log(`[UPDATE-ROLE] Upgrading user ${userId} to dealer. Adjusting margins...`)

            // Get all shop_packages for this shop
            const { data: shopPackages, error: pkgError } = await supabase
                .from("shop_packages")
                .select("id, package_id, profit_margin")
                .eq("shop_id", targetShop.id)

            if (!pkgError && shopPackages && shopPackages.length > 0) {
                // Get all packages with dealer prices
                const packageIds = shopPackages.map((sp: any) => sp.package_id)
                const { data: packages, error: priceError } = await supabase
                    .from("packages")
                    .select("id, price, dealer_price")
                    .in("id", packageIds)

                if (!priceError && packages) {
                    // Create a map for quick lookup
                    const priceMap = new Map()
                    packages.forEach((pkg: any) => {
                        priceMap.set(pkg.id, { adminPrice: pkg.price, dealerPrice: pkg.dealer_price })
                    })

                    // Update each shop_package margin
                    for (const shopPkg of shopPackages) {
                        const prices = priceMap.get(shopPkg.package_id)
                        if (prices && prices.dealerPrice !== null && prices.dealerPrice < prices.adminPrice) {
                            // Calculate the difference
                            const priceDiff = prices.adminPrice - prices.dealerPrice
                            const newMargin = (shopPkg.profit_margin || 0) + priceDiff

                            await supabase
                                .from("shop_packages")
                                .update({ profit_margin: newMargin })
                                .eq("id", shopPkg.id)

                            console.log(`[UPDATE-ROLE] Adjusted package ${shopPkg.package_id}: margin ${shopPkg.profit_margin} -> ${newMargin}`)
                        }
                    }
                }
            }
        }

        // Also update user_metadata in auth (for session data)
        const { error: metaError } = await supabase.auth.admin.updateUserById(userId, {
            user_metadata: { role: newRole }
        })

        if (metaError) {
            console.warn("[UPDATE-ROLE] Could not update auth metadata:", metaError.message)
            // Non-blocking - the users table is the source of truth
        }

        console.log(`[UPDATE-ROLE] User ${userId} role updated to: ${newRole}`)

        return NextResponse.json({
            success: true,
            message: `User role updated to '${newRole}'`,
            userId,
            newRole
        })

    } catch (error) {
        console.error("[UPDATE-ROLE] Error:", error)
        return NextResponse.json(
            { error: "Failed to update user role" },
            { status: 500 }
        )
    }
}
