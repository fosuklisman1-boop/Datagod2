import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    
    const orderId = formData.get("orderId") as string
    const orderType = formData.get("orderType") as string || "regular" // "regular" or "shop"
    const description = formData.get("description") as string
    const priority = formData.get("priority") as string
    const orderDetailsStr = formData.get("orderDetails") as string
    const userId = formData.get("userId") as string
    const balanceImage = formData.get("balanceImage") as File
    const momoReceiptImage = formData.get("momoReceiptImage") as File | null

    console.log("[COMPLAINTS-API] Received request with:", {
      orderId,
      orderType,
      userId,
      description: description?.substring(0, 50),
      priority,
      balanceImage: !!balanceImage,
      momoReceiptImage: !!momoReceiptImage,
    })

    // Validate required fields (momoReceiptImage is optional)
    if (!orderId || !description || !priority || !orderDetailsStr || !userId || !balanceImage) {
      console.error("[COMPLAINTS-API] Missing required fields:", {
        orderId: !!orderId,
        description: !!description,
        priority: !!priority,
        orderDetailsStr: !!orderDetailsStr,
        userId: !!userId,
        balanceImage: !!balanceImage,
      })
      return NextResponse.json(
        { message: "Missing required fields" },
        { status: 400 }
      )
    }

    const orderDetails = JSON.parse(orderDetailsStr)

    // Upload balance image
    const balanceFileName = `${userId}/${orderId}/balance-${Date.now()}.${balanceImage.name.split(".").pop()}`
    const balanceBuffer = await balanceImage.arrayBuffer()
    
    console.log("[COMPLAINTS-API] Uploading balance image:", balanceFileName)
    
    const { error: balanceUploadError } = await supabase.storage
      .from("complaint-evidence")
      .upload(balanceFileName, balanceBuffer, {
        contentType: balanceImage.type,
        upsert: false,
      })

    if (balanceUploadError) {
      console.error("[COMPLAINTS-API] Balance image upload error:", balanceUploadError)
      return NextResponse.json(
        { message: "Failed to upload balance image: " + balanceUploadError.message },
        { status: 500 }
      )
    }

    // Upload MoMo receipt image (optional)
    let momoFileName = ""
    let momoUrlData: any = null
    
    if (momoReceiptImage && momoReceiptImage.size > 0) {
      momoFileName = `${userId}/${orderId}/receipt-${Date.now()}.${momoReceiptImage.name.split(".").pop()}`
      const momoBuffer = await momoReceiptImage.arrayBuffer()
      
      console.log("[COMPLAINTS-API] Uploading MoMo receipt:", momoFileName)
      
      const { error: momoUploadError } = await supabase.storage
        .from("complaint-evidence")
        .upload(momoFileName, momoBuffer, {
          contentType: momoReceiptImage.type,
          upsert: false,
        })

      if (momoUploadError) {
        console.error("[COMPLAINTS-API] MoMo receipt upload error:", momoUploadError)
        return NextResponse.json(
          { message: "Failed to upload receipt image: " + momoUploadError.message },
          { status: 500 }
        )
      }

      // Get signed URL for MoMo receipt (valid for 24 hours)
      const { data: momoSignedUrlData } = await supabase.storage
        .from("complaint-evidence")
        .createSignedUrl(momoFileName, 24 * 60 * 60) // 24 hours
      
      momoUrlData = momoSignedUrlData
    }

    // Get signed URL for balance image (valid for 24 hours)
    const { data: balanceSignedUrlData } = await supabase.storage
      .from("complaint-evidence")
      .createSignedUrl(balanceFileName, 24 * 60 * 60) // 24 hours

    console.log("[COMPLAINTS-API] Creating complaint record...")
    
    // For shop orders, we can't use the order_id foreign key directly
    // Instead, store the order reference in order_details
    const complaintData: any = {
      user_id: userId,
      title: `Data Issue - ${orderDetails.networkName} ${orderDetails.packageName}`,
      description: description,
      priority: priority,
      status: "pending",
      order_details: {
        type: orderType,
        orderRefId: orderId, // Store the original ID (could be shop_order or regular order)
        network: orderDetails.networkName,
        package: orderDetails.packageName,
        phone: orderDetails.phoneNumber,
        amount: orderDetails.totalPrice,
        date: orderDetails.createdAt,
      },
      evidence: {
        balance_image_url: balanceSignedUrlData?.signedUrl || null,
        momo_receipt_url: momoUrlData?.signedUrl || null,
        balance_image_path: balanceFileName,
        momo_receipt_path: momoFileName || null,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Only add order_id if it's a regular order (to satisfy FK constraint)
    if (orderType === "regular") {
      complaintData.order_id = orderId
    }

    // Create complaint record
    const { data: complaint, error: complaintError } = await supabase
      .from("complaints")
      .insert([complaintData])
      .select()

    if (complaintError) {
      console.error("[COMPLAINTS-API] Complaint creation error:", complaintError)
      return NextResponse.json(
        { message: "Failed to create complaint: " + complaintError.message },
        { status: 500 }
      )
    }

    console.log("[COMPLAINTS-API] Complaint created successfully:", complaint[0].id)

    // Send notification to user
    try {
      const complaintTitle = `Data Issue - ${orderDetails.networkName} ${orderDetails.packageName}`
      const notificationData = notificationTemplates.complaintSubmitted(complaint[0].id, complaintTitle)
      const notifResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/notifications/create-admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          title: notificationData.title,
          message: notificationData.message,
          type: notificationData.type,
          reference_id: notificationData.reference_id,
          action_url: `/dashboard/complaints?id=${complaint[0].id}`,
        }),
      })
      if (notifResponse.ok) {
        console.log("[NOTIFICATION] Complaint submitted notification sent to user", userId)
      } else {
        const errorData = await notifResponse.json()
        console.warn("[NOTIFICATION] Failed to send complaint submitted notification:", errorData.error)
      }
    } catch (notifError) {
      console.warn("[NOTIFICATION] Failed to send complaint submitted notification:", notifError)
      // Don't fail the complaint creation if notification fails
    }

    return NextResponse.json({
      message: "Complaint submitted successfully",
      complaint: complaint[0],
    })
  } catch (error) {
    console.error("[COMPLAINTS-API] Error in complaint creation:", error)
    const errorMessage = error instanceof Error ? error.message : "Internal server error"
    return NextResponse.json(
      { message: errorMessage },
      { status: 500 }
    )
  }
}
