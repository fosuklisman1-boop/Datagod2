import { createClient } from "@supabase/supabase-js"
import { notificationService } from "./notification-service"
import { notifyFulfillmentFailure } from "./sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const codecraftApiUrl = process.env.CODECRAFT_API_URL || "https://api.codecraftnetwork.com/api"
const codecraftApiKey = process.env.CODECRAFT_API_KEY!

interface FulfillmentRequest {
  phoneNumber: string
  sizeGb: number
  orderId: string
  network?: string
  orderType?: "wallet" | "shop"  // wallet = orders table, shop = shop_orders table
  isBigTime?: boolean  // true for AT-BigTime orders (uses special.php endpoint)
  customer_email?: string // For Big Time orders, mapped to client_email
}

interface FulfillmentResponse {
  success: boolean
  reference?: string
  message?: string
  errorCode?: string
  statusCode?: number
}

interface FulfillmentLog {
  id: string
  order_id: string
  status: string
  attempt_number: number
  max_attempts: number
  api_response: Record<string, any>
  error_message?: string
  retry_after?: string
}

class ATiShareService {
  private supabase = createClient(supabaseUrl, serviceRoleKey)

  /**
   * Fulfill an AT-iShare order by calling Code Craft Network API
   * For AT-BigTime orders, uses the special.php endpoint
   */
  async fulfillOrder(request: FulfillmentRequest): Promise<FulfillmentResponse> {
    const { phoneNumber, sizeGb, orderId, network = "AT", orderType = "wallet", isBigTime = false, customer_email } = request

    try {
      console.log(`[CODECRAFT-FULFILL] Starting fulfillment request`)
      console.log(`[CODECRAFT-FULFILL] Order ID: ${orderId}`)
      console.log(`[CODECRAFT-FULFILL] Order Type: ${orderType}`)
      console.log(`[CODECRAFT-FULFILL] Phone Number: ${phoneNumber}`)
      console.log(`[CODECRAFT-FULFILL] Size: ${sizeGb}GB`)
      console.log(`[CODECRAFT-FULFILL] Network: ${network}`)
      console.log(`[CODECRAFT-FULFILL] Is BigTime: ${isBigTime}`)

      // Validate inputs - sizeGb must be greater than 0
      if (!phoneNumber || !orderId) {
        const errorMsg = `Missing required fields: phoneNumber=${phoneNumber}, orderId=${orderId}`
        console.error(`[CODECRAFT-FULFILL] ❌ ${errorMsg}`)
        // Log this validation error
        try {
          await this.logFulfillment(
            orderId || "unknown",
            "failed",
            { validation_error: true },
            errorMsg,
            undefined,
            phoneNumber,
            network,
            orderType
          )
        } catch (e) {
          console.error(`[CODECRAFT-FULFILL] Could not log validation error:`, e)
        }
        return {
          success: false,
          errorCode: "INVALID_INPUT",
          message: errorMsg,
        }
      }

      // Validate sizeGb - must be greater than 0
      if (!sizeGb || sizeGb <= 0) {
        const errorMsg = `Invalid size: ${sizeGb}GB. Size must be greater than 0.`
        console.error(`[CODECRAFT-FULFILL] ❌ ${errorMsg}`)
        try {
          await this.logFulfillment(
            orderId,
            "failed",
            { validation_error: true, received_size: sizeGb },
            errorMsg,
            undefined,
            phoneNumber,
            network,
            orderType
          )
        } catch (e) {
          console.error(`[CODECRAFT-FULFILL] Could not log validation error:`, e)
        }
        return {
          success: false,
          errorCode: "INVALID_SIZE",
          message: errorMsg,
        }
      }

      // Validate network (must be MTN, TELECEL, or AT)
      const validNetworks = ["MTN", "TELECEL", "AT"]
      if (!validNetworks.includes(network)) {
        const errorMsg = `Invalid network: ${network}. Must be one of: ${validNetworks.join(", ")}`
        console.error(`[CODECRAFT-FULFILL] ❌ ${errorMsg}`)
        // Log this validation error
        try {
          await this.logFulfillment(
            orderId,
            "failed",
            { validation_error: true },
            errorMsg,
            undefined,
            phoneNumber,
            network,
            orderType
          )
        } catch (e) {
          console.error(`[CODECRAFT-FULFILL] Could not log validation error:`, e)
        }
        return {
          success: false,
          errorCode: "INVALID_NETWORK",
          message: errorMsg,
        }
      }

      // Prepare Code Craft Network API request

      // Build API request, add client_email for Big Time (required by special.php)
      const apiRequest: Record<string, any> = {
        agent_api: codecraftApiKey,
        recipient_number: phoneNumber,
        network: network,
        gig: sizeGb.toString(),
        reference_id: orderId,
      };
      
      // For BigTime orders, client_email is REQUIRED by the Code Craft API
      if (isBigTime) {
        if (!customer_email) {
          const errorMsg = `BigTime order requires client_email but none was provided`;
          console.error(`[CODECRAFT-FULFILL] ❌ ${errorMsg}`);
          return {
            success: false,
            errorCode: "MISSING_EMAIL",
            message: errorMsg,
          };
        }
        apiRequest.client_email = customer_email;
        console.log(`[CODECRAFT-FULFILL] BigTime order - client_email: ${customer_email}`);
      }

      // Use different endpoint for BigTime orders
      const apiEndpoint = isBigTime ? `${codecraftApiUrl}/special.php` : `${codecraftApiUrl}/initiate.php`

      console.log(`[CODECRAFT-FULFILL] Calling Code Craft API...`)
      console.log(`[CODECRAFT-FULFILL] API URL: ${apiEndpoint}`)
      console.log(`[CODECRAFT-FULFILL] Request payload: agent_api=***, recipient_number=${phoneNumber}, network=${network}, gig=${sizeGb}, reference_id=${orderId}${isBigTime ? `, client_email=${customer_email}` : ''}`)

      // Call Code Craft Network API
      const response = await fetch(apiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(apiRequest),
      })

      const httpStatus = response.status
      const responseText = await response.text()
      
      console.log(`[CODECRAFT-FULFILL] API Response received`)
      console.log(`[CODECRAFT-FULFILL] HTTP Status: ${httpStatus}`)
      console.log(`[CODECRAFT-FULFILL] Raw Response Text:`, responseText)

      // Try to parse JSON from response, handling PHP warnings/errors mixed in
      let responseData: any = {}
      try {
        // First try direct JSON parse
        responseData = JSON.parse(responseText)
      } catch (parseError) {
        // If direct parse fails, try to extract JSON from mixed content
        // PHP sometimes outputs warnings before JSON: <br /> <b>Warning...</b>{"status": ...}
        const jsonMatch = responseText.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            responseData = JSON.parse(jsonMatch[0])
            console.log(`[CODECRAFT-FULFILL] Extracted JSON from mixed response:`, responseData)
          } catch (innerParseError) {
            console.error(`[CODECRAFT-FULFILL] Could not extract valid JSON from response`)
            responseData = { message: "Invalid response from API", raw: responseText.substring(0, 500) }
          }
        } else {
          console.error(`[CODECRAFT-FULFILL] Response is not JSON:`, responseText.substring(0, 500))
          responseData = { message: "Non-JSON response from API", raw: responseText.substring(0, 500) }
        }
      }

      console.log(`[CODECRAFT-FULFILL] Response Data:`, responseData)

      // Handle response based on HTTP status code
      // HTTP 200 = Success (as per API documentation)
      // Other codes = Failed
      if (httpStatus === 200) {
        console.log(`[CODECRAFT] Order request accepted: ${orderId}`)
        console.log(`[CODECRAFT] API Message: ${responseData.message || "Sent Successfully"}`)
        
        // Log fulfillment attempt (initially as "processing")
        await this.logFulfillment(
          orderId,
          "processing",
          responseData,
          null,
          orderId,
          phoneNumber,
          network,
          orderType
        )

        // Poll for status up to 3 times (5s, 10s, 15s = 30 seconds total)
        const pollIntervals = [5000, 10000, 15000] // Wait 5s, then 10s, then 15s
        let verifyResult: { actualStatus: string; message?: string } = { actualStatus: "processing", message: "Order still processing" }

        for (let i = 0; i < pollIntervals.length; i++) {
          console.log(`[CODECRAFT] Waiting ${pollIntervals[i] / 1000}s before verification attempt ${i + 1}...`)
          await new Promise(resolve => setTimeout(resolve, pollIntervals[i]))

          // Verify the actual status from Code Craft
          verifyResult = await this.verifyAndUpdateStatus(orderId, network, orderType, isBigTime)
          
          console.log(`[CODECRAFT] Verification attempt ${i + 1}: ${verifyResult.actualStatus}`)

          // If we got a final status, stop polling
          if (verifyResult.actualStatus === "completed" || verifyResult.actualStatus === "failed") {
            break
          }
        }
        
        if (verifyResult.actualStatus === "completed") {
          return {
            success: true,
            reference: orderId,
            message: "Order fulfilled and verified successfully",
          }
        } else if (verifyResult.actualStatus === "failed") {
          // Notify admin of failure
          try {
            await notifyFulfillmentFailure(orderId, phoneNumber, network, sizeGb, verifyResult.message || "Delivery failed")
          } catch (smsError) {
            console.error(`[CODECRAFT] Failed to send SMS notification:`, smsError)
          }
          return {
            success: false,
            errorCode: "DELIVERY_FAILED",
            message: verifyResult.message || "Order delivery failed after verification",
          }
        } else {
          // Still pending after initial retries - schedule for later checks
          // Attempt 4: 30 min, Attempt 5: 60 min, Attempt 6: 24 hrs
          console.log(`[CODECRAFT] Order ${orderId} still processing after ${pollIntervals.length} verification attempts - scheduling for later checks`)
          
          // Update fulfillment log with next check time (30 minutes from now)
          const nextCheckTime = new Date(Date.now() + 30 * 60 * 1000).toISOString()
          await this.supabase
            .from("fulfillment_logs")
            .update({ 
              attempt_number: 3,
              retry_after: nextCheckTime,
              updated_at: new Date().toISOString()
            })
            .eq("order_id", orderId)

          return {
            success: true,
            reference: orderId,
            message: "Order submitted, awaiting confirmation from network (will be checked again in 30 min)",
          }
        }
      }

      // HTTP status is not 200 - order failed
      const errorMessage = responseData.message || `Order Failed: [${httpStatus}] Unknown error`

      console.error(`[CODECRAFT] API Error: HTTP ${httpStatus}`, responseData)
      console.error(`[CODECRAFT] Error Message: ${errorMessage}`)

      // Log failed fulfillment attempt
      await this.logFulfillment(
        orderId,
        "failed",
        responseData,
        errorMessage,
        undefined,
        phoneNumber,
        network,
        orderType
      )

      // Send SMS notification to admin(s) about the failure
      try {
        await notifyFulfillmentFailure(orderId, phoneNumber, network, sizeGb, errorMessage)
      } catch (smsError) {
        console.error(`[CODECRAFT] Failed to send SMS notification:`, smsError)
      }

      return {
        success: false,
        statusCode: httpStatus,
        errorCode: `CODE_${responseData.status || httpStatus}`,
        message: errorMessage,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[CODECRAFT] Fulfillment error for order ${orderId}:`, error)

      // Log the error to fulfillment_logs as well
      try {
        await this.logFulfillment(
          orderId,
          "failed",
          { error: errorMessage },
          errorMessage,
          undefined,
          phoneNumber,
          network,
          orderType
        )
      } catch (logError) {
        console.error(`[CODECRAFT] Failed to log fulfillment error:`, logError)
      }

      // Send SMS notification to admin(s) about the failure
      try {
        await notifyFulfillmentFailure(orderId, phoneNumber, network, sizeGb, errorMessage)
      } catch (smsError) {
        console.error(`[CODECRAFT] Failed to send SMS notification:`, smsError)
      }

      return {
        success: false,
        errorCode: "FULFILLMENT_ERROR",
        message: errorMessage,
      }
    }
  }

  /**
   * Verify order status and update database accordingly
   * Called after initial fulfillment to confirm actual delivery
   */
  async verifyAndUpdateStatus(
    orderId: string, 
    network: string, 
    orderType: "wallet" | "shop",
    isBigTime: boolean = false
  ): Promise<{ actualStatus: string; message?: string }> {
    try {
      console.log(`[CODECRAFT] Verifying actual delivery status for order ${orderId}`)
      console.log(`[CODECRAFT] Network: ${network}, isBigTime: ${isBigTime}`)

      // Determine correct endpoint
      const endpoint = isBigTime ? "response_big_time.php" : "response_regular.php"
      const url = `${codecraftApiUrl}/${endpoint}`

      const requestBody = {
        reference_id: orderId,
        agent_api: codecraftApiKey,
      }

      console.log(`[CODECRAFT] Calling ${url}`)
      console.log(`[CODECRAFT] Request body:`, JSON.stringify(requestBody))

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      })

      console.log(`[CODECRAFT] HTTP Status: ${response.status}`)

      const responseText = await response.text()
      console.log(`[CODECRAFT] Raw response (first 500 chars):`, responseText.substring(0, 500))
      
      let data: any = {}

      try {
        data = JSON.parse(responseText)
      } catch {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            data = JSON.parse(jsonMatch[0])
            console.log(`[CODECRAFT] Extracted JSON from mixed response`)
          } catch {
            console.error(`[CODECRAFT] Could not parse verification response`)
          }
        }
      }

      console.log(`[CODECRAFT] Parsed verification response:`, JSON.stringify(data, null, 2))

      // Check for "no order found" or similar error messages
      const errorMessage = (data.message || data.error || "").toLowerCase()
      if (errorMessage.includes("no order found") || errorMessage.includes("order not found") || errorMessage.includes("invalid reference")) {
        console.log(`[CODECRAFT] ⚠️ Order not found in Code Craft system: ${orderId}`)
        // Keep as processing - don't mark as failed, order may still be queued
        return {
          actualStatus: "processing",
          message: "Order not found in Code Craft - may still be queued",
        }
      }

      // Check multiple possible status locations
      const orderStatus = (
        data.order_details?.order_status || 
        data.order_status || 
        data.status || 
        ""
      ).toLowerCase()

      console.log(`[CODECRAFT] Order status value: "${orderStatus}"`)

      let actualStatus = "processing"
      let message = ""

      if (orderStatus.includes("successful") || orderStatus.includes("delivered") || orderStatus.includes("completed") || orderStatus === "success") {
        actualStatus = "completed"
        message = "Order delivered successfully"
      } else if (orderStatus.includes("failed") || orderStatus.includes("error") || orderStatus.includes("cancelled") || orderStatus.includes("canceled") || orderStatus.includes("rejected") || orderStatus.includes("refund")) {
        actualStatus = "failed"
        message = data.order_details?.order_status || data.message || "Delivery failed/cancelled"
      } else if (orderStatus.includes("pending") || orderStatus.includes("processing") || orderStatus === "") {
        actualStatus = "processing"
        message = "Order still processing"
      }

      console.log(`[CODECRAFT] Determined status: ${actualStatus}, message: ${message}`)

      // Update the order status in database
      if (orderType === "wallet") {
        await this.supabase
          .from("orders")
          .update({ status: actualStatus, updated_at: new Date().toISOString() })
          .eq("id", orderId)
      } else {
        await this.supabase
          .from("shop_orders")
          .update({ order_status: actualStatus, updated_at: new Date().toISOString() })
          .eq("id", orderId)
      }

      // Also update fulfillment log
      await this.supabase
        .from("fulfillment_logs")
        .update({ 
          status: actualStatus === "completed" ? "success" : actualStatus,
          updated_at: new Date().toISOString()
        })
        .eq("order_id", orderId)

      console.log(`[CODECRAFT] Order ${orderId} verified as: ${actualStatus}`)

      return { actualStatus, message }
    } catch (error) {
      console.error(`[CODECRAFT] Verification error:`, error)
      return { actualStatus: "processing", message: "Could not verify status" }
    }
  }

  /**
   * Check and update status of orders that are due for re-verification
   * Called from dashboard or API to process scheduled checks
   * Attempt schedule: Every 15 minutes for 24 hours (max 96 attempts after initial 3)
   */
  async checkScheduledOrders(): Promise<{ checked: number; updated: number }> {
    try {
      console.log(`[CODECRAFT] Checking scheduled orders for status updates...`)

      const now = new Date().toISOString()

      // Get orders that are due for checking (retry_after has passed)
      // Max 99 attempts: 3 initial + 96 scheduled (every 15 min for 24 hrs)
      const { data: dueLogs, error } = await this.supabase
        .from("fulfillment_logs")
        .select("order_id, attempt_number, phone_number, network, order_type")
        .eq("status", "processing")
        .lte("retry_after", now)
        .lt("attempt_number", 99) // Max 99 attempts (3 initial + 96 scheduled)
        .limit(10) // Process max 10 per call to avoid timeout

      if (error || !dueLogs || dueLogs.length === 0) {
        console.log(`[CODECRAFT] No scheduled orders due for checking`)
        return { checked: 0, updated: 0 }
      }

      console.log(`[CODECRAFT] Found ${dueLogs.length} orders due for status check`)

      let checked = 0
      let updated = 0

      for (const log of dueLogs) {
        try {
          checked++
          const networkLower = (log.network || "").toLowerCase()
          const isBigTime = networkLower.includes("bigtime") || networkLower.includes("big time")
          const apiNetwork = networkLower.includes("mtn") ? "MTN" : 
                             networkLower.includes("telecel") ? "TELECEL" : "AT"

          // Verify status
          const result = await this.verifyAndUpdateStatus(
            log.order_id, 
            apiNetwork, 
            log.order_type || "wallet",
            isBigTime
          )

          if (result.actualStatus === "completed" || result.actualStatus === "failed") {
            updated++
            console.log(`[CODECRAFT] Order ${log.order_id} updated to ${result.actualStatus}`)
            
            // If failed, send SMS notification
            if (result.actualStatus === "failed") {
              try {
                const sizeGb = 0 // We don't have size in log, but message has details
                await notifyFulfillmentFailure(log.order_id, log.phone_number || "", log.network || "", sizeGb, result.message || "Delivery failed")
              } catch (smsError) {
                console.error(`[CODECRAFT] Failed to send SMS notification:`, smsError)
              }
            }
          } else {
            // Still processing - schedule next check every 15 minutes for 24 hours
            const attemptNumber = (log.attempt_number || 3) + 1
            
            // Every 15 minutes for 24 hours = 96 attempts max
            // After 99 total attempts (3 initial + 96 scheduled), assume completed
            if (attemptNumber >= 99) {
              console.log(`[CODECRAFT] Order ${log.order_id} max attempts reached (${attemptNumber}), marking as completed`)
              await this.supabase
                .from("fulfillment_logs")
                .update({ 
                  status: "success",
                  updated_at: new Date().toISOString()
                })
                .eq("order_id", log.order_id)
              
              // Update order status to completed
              const tableName = log.order_type === "shop" ? "shop_orders" : "orders"
              const statusField = log.order_type === "shop" ? "order_status" : "status"
              await this.supabase
                .from(tableName)
                .update({ [statusField]: "completed", updated_at: new Date().toISOString() })
                .eq("id", log.order_id)
              
              updated++
              console.log(`[CODECRAFT] Order ${log.order_id} auto-completed after 24 hours`)
              continue
            }

            // Schedule next check in 15 minutes
            const nextCheckMs = 15 * 60 * 1000 // 15 minutes
            const nextCheckTime = new Date(Date.now() + nextCheckMs).toISOString()

            await this.supabase
              .from("fulfillment_logs")
              .update({ 
                attempt_number: attemptNumber,
                retry_after: nextCheckTime,
                updated_at: new Date().toISOString()
              })
              .eq("order_id", log.order_id)

            console.log(`[CODECRAFT] Order ${log.order_id} still processing - next check at ${nextCheckTime} (attempt ${attemptNumber})`)
          }
        } catch (orderError) {
          console.error(`[CODECRAFT] Error checking order ${log.order_id}:`, orderError)
        }
      }

      console.log(`[CODECRAFT] Scheduled check complete. Checked: ${checked}, Updated: ${updated}`)
      return { checked, updated }
    } catch (error) {
      console.error(`[CODECRAFT] Error checking scheduled orders:`, error)
      return { checked: 0, updated: 0 }
    }
  }

  /**
   * Verify if an order has been fulfilled at Code Craft Network
   */
  async verifyFulfillment(orderId: string, network: string = "AT"): Promise<{ success: boolean; details?: any }> {
    try {
      console.log(`[CODECRAFT] Verifying fulfillment for order ${orderId} on ${network}`)

      // Determine correct endpoint based on network
      let endpoint = "response_regular.php"
      if (network === "BIG_TIME" || network === "BIGTIME") {
        endpoint = "response_big_time.php"
      }

      const response = await fetch(`${codecraftApiUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reference_id: orderId,
          agent_api: codecraftApiKey,
        }),
      })

      const data = await response.json()
      
      console.log(`[CODECRAFT] Verification response:`, data)

      // Check if order was successful
      if (data.status === "success" && data.code === 200) {
        const orderStatus = data.order_details?.order_status || "Unknown"
        const isSuccessful = orderStatus.toLowerCase().includes("successful") || orderStatus.toLowerCase().includes("delivered")
        
        return {
          success: isSuccessful,
          details: data.order_details,
        }
      }

      return {
        success: false,
        details: data,
      }
    } catch (error) {
      console.error(`[CODECRAFT] Verification error for order ${orderId}:`, error)
      return {
        success: false,
      }
    }
  }

  /**
   * Handle retry logic with exponential backoff
   */
  async handleRetry(orderId: string): Promise<FulfillmentResponse> {
    try {
      console.log(`[AT-ISHARE] Handling retry for order ${orderId}`)

      // Get current fulfillment log
      const { data: fulfillmentLog, error: fetchError } = await this.supabase
        .from("fulfillment_logs")
        .select("*")
        .eq("order_id", orderId)
        .single()

      if (fetchError || !fulfillmentLog) {
        return {
          success: false,
          errorCode: "LOG_NOT_FOUND",
          message: "Fulfillment log not found",
        }
      }

      const log = fulfillmentLog as FulfillmentLog

      // Check if max attempts reached
      if (log.attempt_number >= log.max_attempts) {
        console.log(
          `[AT-ISHARE] Max retry attempts (${log.max_attempts}) reached for order ${orderId}`
        )
        return {
          success: false,
          errorCode: "MAX_RETRIES_EXCEEDED",
          message: `Max retry attempts (${log.max_attempts}) exceeded`,
        }
      }

      // Get order details for retry
      const { data: order, error: orderError } = await this.supabase
        .from("orders")
        .select("phone_number, size, network")
        .eq("id", orderId)
        .single()

      if (orderError || !order) {
        return {
          success: false,
          errorCode: "ORDER_NOT_FOUND",
          message: "Order not found",
        }
      }

      // Extract size in GB
      const sizeGb = parseInt(order.size.toString().replace(/[^0-9]/g, "")) || 0

      // Determine network type for API
      const networkLower = (order.network || "").toLowerCase()
      const isBigTime = networkLower.includes("bigtime") || networkLower.includes("big time")
      const apiNetwork = networkLower.includes("mtn") ? "MTN" : 
                         networkLower.includes("telecel") ? "TELECEL" : "AT"

      // Retry the fulfillment
      const result = await this.fulfillOrder({
        phoneNumber: order.phone_number,
        sizeGb,
        orderId,
        network: apiNetwork,
        orderType: "wallet",
        isBigTime,
      })

      if (result.success) {
        // Update fulfillment log
        await this.updateFulfillmentLog(orderId, "success", result)
      } else {
        // Increment attempt and calculate retry time
        const nextRetryTime = this.calculateNextRetryTime(log.attempt_number)

        await this.supabase
          .from("fulfillment_logs")
          .update({
            attempt_number: log.attempt_number + 1,
            status: "failed",
            error_message: result.message,
            retry_after: nextRetryTime,
            api_response: result,
            updated_at: new Date().toISOString(),
          })
          .eq("order_id", orderId)
      }

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[AT-ISHARE] Retry error for order ${orderId}:`, error)

      return {
        success: false,
        errorCode: "RETRY_ERROR",
        message: errorMessage,
      }
    }
  }

  /**
   * Log fulfillment attempt to database
   */
  private async logFulfillment(
    orderId: string,
    status: "pending" | "processing" | "success" | "failed",
    apiResponse: Record<string, any>,
    errorMessage?: string | null,
    reference?: string,
    phoneNumber?: string,
    network?: string,
    orderType: "wallet" | "shop" = "wallet"
  ): Promise<void> {
    try {
      console.log(`[CODECRAFT-LOG] Logging fulfillment attempt for order ${orderId}`)
      console.log(`[CODECRAFT-LOG] Order Type: ${orderType}`)
      console.log(`[CODECRAFT-LOG] Status: ${status}`)
      console.log(`[CODECRAFT-LOG] Error Message: ${errorMessage || "None"}`)
      console.log(`[CODECRAFT-LOG] Phone: ${phoneNumber || "N/A"}`)
      console.log(`[CODECRAFT-LOG] Network: ${network || "N/A"}`)
      
      // Validate required fields - these are NOT NULL in database
      if (!phoneNumber || !phoneNumber.trim()) {
        throw new Error(`Cannot log fulfillment: phoneNumber is required but got "${phoneNumber}"`)
      }
      if (!network || !network.trim()) {
        throw new Error(`Cannot log fulfillment: network is required but got "${network}"`)
      }
      
      // Build the record with required fields
      const logRecord: any = {
        order_id: orderId,
        order_type: orderType,
        status,
        phone_number: phoneNumber.trim(),
        network: network.trim(),
        api_response: apiResponse,
        error_message: errorMessage,
        fulfilled_at: status === "success" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }

      console.log(`[CODECRAFT-LOG] Attempting to insert fulfillment log with record:`, logRecord)
      
      const { data, error } = await this.supabase.from("fulfillment_logs").insert(
        [logRecord]
      ).select()

      if (error) {
        console.error(`[CODECRAFT-LOG] ❌ Error inserting fulfillment log for order ${orderId}`)
        console.error(`[CODECRAFT-LOG] Error message: ${error.message}`)
        console.error(`[CODECRAFT-LOG] Error code: ${error.code}`)
        console.error(`[CODECRAFT-LOG] Error details:`, JSON.stringify(error, null, 2))
        // Don't throw - continue to update order status even if log insert fails
        console.error(`[CODECRAFT-LOG] Continuing to update order status despite log insert failure`)
      } else {
        console.log(`[CODECRAFT-LOG] ✅ Successfully logged fulfillment status to database`)
        console.log(`[CODECRAFT-LOG] Inserted record:`, data)
      }

      // Update order status based on order type
      // Map fulfillment status to order status: success -> completed
      const orderStatus = status === "success" ? "completed" : status
      console.log(`[CODECRAFT-LOG] Updating order ${orderId} (type: ${orderType}) with status: ${orderStatus}`)
      
      // Use appropriate table based on order type
      const tableName = orderType === "shop" ? "shop_orders" : "orders"
      
      console.log(`[CODECRAFT-LOG] Table: ${tableName}`)
      
      // Build update object based on order type
      let updateData: Record<string, any> = {
        updated_at: new Date().toISOString(),
      }
      
      if (orderType === "shop") {
        // For shop orders: update order_status
        updateData.order_status = orderStatus
      } else {
        // For wallet/bulk orders: update BOTH status and fulfillment_status
        updateData.status = orderStatus
        updateData.fulfillment_status = orderStatus
      }
      
      console.log(`[CODECRAFT-LOG] Update data:`, updateData)
      
      const { error: updateError } = await this.supabase
        .from(tableName)
        .update(updateData)
        .eq("id", orderId)
      
      if (updateError) {
        console.error(`[CODECRAFT-LOG] ❌ Error updating ${tableName}:`, updateError)
        console.error(`[CODECRAFT-LOG] Update error message: ${updateError.message}`)
        console.error(`[CODECRAFT-LOG] Update error code: ${updateError.code}`)
      } else {
        console.log(`[CODECRAFT-LOG] ✅ Successfully updated ${tableName} to "${orderStatus}"`)
        
        // Send in-app notification when fulfillment is successful
        if (orderStatus === "completed") {
          try {
            let userId: string | null = null
            
            if (orderType === "shop") {
              // For shop orders, get shop owner's user_id
              const { data: shopOrder } = await this.supabase
                .from("shop_orders")
                .select("shop_id")
                .eq("id", orderId)
                .single()
              
              if (shopOrder?.shop_id) {
                const { data: shop } = await this.supabase
                  .from("user_shops")
                  .select("user_id")
                  .eq("id", shopOrder.shop_id)
                  .single()
                userId = shop?.user_id
              }
            } else {
              // For wallet orders, get user_id from order
              const { data: order } = await this.supabase
                .from("orders")
                .select("user_id")
                .eq("id", orderId)
                .single()
              userId = order?.user_id
            }
            
            if (userId) {
              await notificationService.createNotification(
                userId,
                "Order Fulfilled Successfully",
                `Your AT-iShare data order to ${phoneNumber} has been delivered successfully.`,
                "order_update",
                { reference_id: orderId }
              )
              console.log(`[CODECRAFT-LOG] ✅ Notification sent to user ${userId}`)
            }
          } catch (notifError) {
            console.error(`[CODECRAFT-LOG] Failed to send notification:`, notifError)
            // Non-blocking: don't fail fulfillment if notification fails
          }
        }
      }
    } catch (error) {
      console.error(`[CODECRAFT-LOG] Error in logFulfillment:`, error)
    }
  }

  /**
   * Update fulfillment log after retry
   */
  private async updateFulfillmentLog(
    orderId: string,
    status: "success" | "failed",
    response: FulfillmentResponse
  ): Promise<void> {
    try {
      const { error } = await this.supabase
        .from("fulfillment_logs")
        .update({
          status,
          api_response: response,
          fulfilled_at: status === "success" ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("order_id", orderId)

      if (error) {
        console.error(`[AT-ISHARE] Error updating fulfillment log for order ${orderId}:`, error)
      }

      // Update order status
      await this.supabase
        .from("orders")
        .update({
          fulfillment_status: status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
    } catch (error) {
      console.error(`[AT-ISHARE] Error in updateFulfillmentLog:`, error)
    }
  }

  /**
   * Calculate next retry time with exponential backoff
   * Attempt 1: 5 minutes
   * Attempt 2: 15 minutes
   * Attempt 3: 1 hour
   */
  private calculateNextRetryTime(attemptNumber: number): string {
    let delayMinutes = 5

    if (attemptNumber === 2) {
      delayMinutes = 15
    } else if (attemptNumber === 3) {
      delayMinutes = 60
    }

    const nextTime = new Date()
    nextTime.setMinutes(nextTime.getMinutes() + delayMinutes)
    return nextTime.toISOString()
  }

  /**
   * Get fulfillment status of an order
   */
  async getFulfillmentStatus(orderId: string): Promise<FulfillmentLog | null> {
    try {
      const { data, error } = await this.supabase
        .from("fulfillment_logs")
        .select("*")
        .eq("order_id", orderId)
        .single()

      if (error || !data) {
        console.log(`[AT-ISHARE] No fulfillment log found for order ${orderId}`)
        return null
      }

      return data as FulfillmentLog
    } catch (error) {
      console.error(`[AT-ISHARE] Error getting fulfillment status:`, error)
      return null
    }
  }

  /**
   * Check if fulfillment is needed for an order
   * Fulfillment is needed for MTN, TELECEL, and AT networks
   */
  async shouldFulfill(orderId: string): Promise<boolean> {
    try {
      const { data, error } = await this.supabase
        .from("orders")
        .select("network, fulfillment_status")
        .eq("id", orderId)
        .single()

      if (error || !data) {
        return false
      }

      // Fulfill orders ONLY for AT - iShare network that haven't been fulfilled
      // Do NOT fulfill MTN, TELECEL, or other networks - they're handled differently
      const atishareNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare"]
      const networkMatches = atishareNetworks.some(n => n.toLowerCase() === (data.network || "").toLowerCase())
      return (
        networkMatches && 
        (data.fulfillment_status === "pending" || !data.fulfillment_status)
      )
    } catch (error) {
      console.error(`[CODECRAFT] Error checking if fulfillment needed:`, error)
      return false
    }
  }
}

// Export singleton instance
export const atishareService = new ATiShareService()
