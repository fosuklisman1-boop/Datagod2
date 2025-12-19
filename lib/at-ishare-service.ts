import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const codecraftApiUrl = process.env.CODECRAFT_API_URL || "https://api.codecraftnetwork.com/api"
const codecraftApiKey = process.env.CODECRAFT_API_KEY!

interface FulfillmentRequest {
  phoneNumber: string
  sizeGb: number
  orderId: string
  network?: string
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
   */
  async fulfillOrder(request: FulfillmentRequest): Promise<FulfillmentResponse> {
    const { phoneNumber, sizeGb, orderId, network = "AT" } = request

    try {
      console.log(`[CODECRAFT-FULFILL] Starting fulfillment request`)
      console.log(`[CODECRAFT-FULFILL] Order ID: ${orderId}`)
      console.log(`[CODECRAFT-FULFILL] Phone Number: ${phoneNumber}`)
      console.log(`[CODECRAFT-FULFILL] Size: ${sizeGb}GB`)
      console.log(`[CODECRAFT-FULFILL] Network: ${network}`)

      // Validate inputs
      if (!phoneNumber || !sizeGb || !orderId) {
        const errorMsg = `Missing required fields: phoneNumber=${phoneNumber}, sizeGb=${sizeGb}, orderId=${orderId}`
        console.error(`[CODECRAFT-FULFILL] ${errorMsg}`)
        return {
          success: false,
          errorCode: "INVALID_INPUT",
          message: errorMsg,
        }
      }

      // Validate network (must be MTN, TELECEL, or AT)
      const validNetworks = ["MTN", "TELECEL", "AT"]
      if (!validNetworks.includes(network)) {
        const errorMsg = `Invalid network: ${network}. Must be one of: ${validNetworks.join(", ")}`
        console.error(`[CODECRAFT-FULFILL] ${errorMsg}`)
        return {
          success: false,
          errorCode: "INVALID_NETWORK",
          message: errorMsg,
        }
      }

      // Prepare Code Craft Network API request
      const apiRequest = {
        agent_api: codecraftApiKey,
        recipient_number: phoneNumber,
        network: network,
        gig: sizeGb.toString(),
        reference_id: orderId,
      }

      console.log(`[CODECRAFT-FULFILL] Calling Code Craft API...`)
      console.log(`[CODECRAFT-FULFILL] API URL: ${codecraftApiUrl}/initiate.php`)
      console.log(`[CODECRAFT-FULFILL] Request payload: agent_api=***, recipient_number=${phoneNumber}, network=${network}, gig=${sizeGb}, reference_id=${orderId}`)

      // Call Code Craft Network API
      const response = await fetch(`${codecraftApiUrl}/initiate.php`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(apiRequest),
      })

      const responseData = await response.json()
      const httpStatus = response.status

      console.log(`[CODECRAFT-FULFILL] API Response received`)
      console.log(`[CODECRAFT-FULFILL] HTTP Status: ${httpStatus}`)
      console.log(`[CODECRAFT-FULFILL] Response Data:`, responseData)

      // Handle specific status codes from API
      if (httpStatus === 200 && responseData.status === 200) {
        console.log(`[CODECRAFT] Order initiated successfully: ${orderId}`)
        
        // Log successful fulfillment initiation
        await this.logFulfillment(
          orderId,
          "processing",
          responseData,
          null,
          orderId // Use order ID as reference
        )

        return {
          success: true,
          reference: orderId,
          message: "Order initiated successfully, awaiting delivery",
        }
      }

      // Map error codes to messages
      const errorCodeMap: Record<number, string> = {
        100: "Admin wallet balance is low",
        101: "Service out of stock",
        102: "Agent not found",
        103: "Price not found",
        555: "Network not found",
        500: responseData.message || "Server error",
      }

      const errorMessage = errorCodeMap[responseData.status || httpStatus] || `API Error: ${responseData.message || "Unknown error"}`

      console.error(`[CODECRAFT] API Error: ${responseData.status}`, responseData)

      // Log failed fulfillment attempt
      await this.logFulfillment(
        orderId,
        "failed",
        responseData,
        errorMessage,
        undefined
      )

      return {
        success: false,
        statusCode: httpStatus,
        errorCode: `CODE_${responseData.status || httpStatus}`,
        message: errorMessage,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[CODECRAFT] Fulfillment error for order ${orderId}:`, error)

      return {
        success: false,
        errorCode: "FULFILLMENT_ERROR",
        message: errorMessage,
      }
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

      // Retry the fulfillment
      const result = await this.fulfillOrder({
        phoneNumber: order.phone_number,
        sizeGb,
        orderId,
        network: order.network,
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
    reference?: string
  ): Promise<void> {
    try {
      console.log(`[CODECRAFT-LOG] Logging fulfillment attempt for order ${orderId}`)
      console.log(`[CODECRAFT-LOG] Status: ${status}`)
      console.log(`[CODECRAFT-LOG] Error Message: ${errorMessage || "None"}`)
      
      const { error } = await this.supabase.from("fulfillment_logs").upsert(
        [
          {
            order_id: orderId,
            status,
            api_response: apiResponse,
            error_message: errorMessage,
            fulfilled_at: status === "success" ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: "order_id" }
      )

      if (error) {
        console.error(`[CODECRAFT-LOG] Error inserting fulfillment log for order ${orderId}:`, error)
      } else {
        console.log(`[CODECRAFT-LOG] Successfully logged fulfillment status to database`)
      }

      // Update order status
      // For Code Craft API, initial response means "processing" since delivery happens async
      const orderStatus = status === "processing" ? "processing" : status
      console.log(`[CODECRAFT-LOG] Updating order ${orderId} with fulfillment_status: ${orderStatus}`)
      
      const { error: updateError } = await this.supabase
        .from("orders")
        .update({
          fulfillment_status: orderStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
      
      if (updateError) {
        console.error(`[CODECRAFT-LOG] Error updating order fulfillment_status:`, updateError)
      } else {
        console.log(`[CODECRAFT-LOG] Successfully updated order fulfillment_status in database`)
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

      // Fulfill orders for MTN, TELECEL, and AT networks that haven't been fulfilled
      const fulfillableNetworks = ["MTN", "TELECEL", "AT", "AT-iShare"]
      return (
        fulfillableNetworks.includes(data.network) && 
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
