import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    
    const orderId = formData.get("orderId") as string
    const description = formData.get("description") as string
    const priority = formData.get("priority") as string
    const orderDetailsStr = formData.get("orderDetails") as string
    const userId = formData.get("userId") as string
    const balanceImage = formData.get("balanceImage") as File
    const momoReceiptImage = formData.get("momoReceiptImage") as File

    // Validate required fields
    if (!orderId || !description || !priority || !orderDetailsStr || !userId || !balanceImage || !momoReceiptImage) {
      return NextResponse.json(
        { message: "Missing required fields" },
        { status: 400 }
      )
    }

    const orderDetails = JSON.parse(orderDetailsStr)

    // Upload balance image
    const balanceFileName = `${userId}/${orderId}/balance-${Date.now()}.${balanceImage.name.split(".").pop()}`
    const balanceBuffer = await balanceImage.arrayBuffer()
    
    const { error: balanceUploadError } = await supabase.storage
      .from("complaint-evidence")
      .upload(balanceFileName, balanceBuffer, {
        contentType: balanceImage.type,
        upsert: false,
      })

    if (balanceUploadError) {
      console.error("Balance image upload error:", balanceUploadError)
      return NextResponse.json(
        { message: "Failed to upload balance image" },
        { status: 500 }
      )
    }

    // Upload MoMo receipt image
    const momoFileName = `${userId}/${orderId}/receipt-${Date.now()}.${momoReceiptImage.name.split(".").pop()}`
    const momoBuffer = await momoReceiptImage.arrayBuffer()
    
    const { error: momoUploadError } = await supabase.storage
      .from("complaint-evidence")
      .upload(momoFileName, momoBuffer, {
        contentType: momoReceiptImage.type,
        upsert: false,
      })

    if (momoUploadError) {
      console.error("MoMo receipt upload error:", momoUploadError)
      return NextResponse.json(
        { message: "Failed to upload receipt image" },
        { status: 500 }
      )
    }

    // Get public URLs
    const { data: balanceUrlData } = supabase.storage
      .from("complaint-evidence")
      .getPublicUrl(balanceFileName)

    const { data: momoUrlData } = supabase.storage
      .from("complaint-evidence")
      .getPublicUrl(momoFileName)

    // Create complaint record
    const { data: complaint, error: complaintError } = await supabase
      .from("complaints")
      .insert([
        {
          user_id: userId,
          order_id: orderId,
          title: `Data Issue - ${orderDetails.networkName} ${orderDetails.packageName}`,
          description: description,
          priority: priority,
          status: "pending",
          order_details: {
            network: orderDetails.networkName,
            package: orderDetails.packageName,
            phone: orderDetails.phoneNumber,
            amount: orderDetails.totalPrice,
            date: orderDetails.createdAt,
          },
          evidence: {
            balance_image_url: balanceUrlData.publicUrl,
            momo_receipt_url: momoUrlData.publicUrl,
            balance_image_path: balanceFileName,
            momo_receipt_path: momoFileName,
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
      .select()

    if (complaintError) {
      console.error("Complaint creation error:", complaintError)
      return NextResponse.json(
        { message: "Failed to create complaint" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      message: "Complaint submitted successfully",
      complaint: complaint[0],
    })
  } catch (error) {
    console.error("Error in complaint creation:", error)
    return NextResponse.json(
      { message: "Internal server error" },
      { status: 500 }
    )
  }
}
