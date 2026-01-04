/**
 * Safe error response utility for production
 * Never exposes raw error details to users
 */

// Generic error messages for different scenarios
export const ERROR_MESSAGES = {
  // Authentication
  UNAUTHORIZED: "Please log in to continue",
  INVALID_TOKEN: "Session expired. Please log in again",
  FORBIDDEN: "You don't have permission to access this resource",
  
  // Validation
  MISSING_FIELDS: "Please fill in all required fields",
  INVALID_INPUT: "Invalid input. Please check your data",
  INVALID_PHONE: "Please enter a valid phone number",
  INVALID_EMAIL: "Please enter a valid email address",
  
  // Resources
  NOT_FOUND: "Resource not found",
  SHOP_NOT_FOUND: "Shop not found",
  ORDER_NOT_FOUND: "Order not found",
  PACKAGE_NOT_FOUND: "Package not found",
  USER_NOT_FOUND: "User not found",
  
  // Operations
  CREATE_FAILED: "Failed to create. Please try again",
  UPDATE_FAILED: "Failed to update. Please try again",
  DELETE_FAILED: "Failed to delete. Please try again",
  FETCH_FAILED: "Failed to load data. Please try again",
  
  // Payment
  PAYMENT_FAILED: "Payment failed. Please try again",
  INSUFFICIENT_BALANCE: "Insufficient balance",
  
  // General
  SERVER_ERROR: "Something went wrong. Please try again later",
  RATE_LIMITED: "Too many requests. Please wait a moment",
}

/**
 * Log error details server-side and return a safe message
 */
export function handleApiError(
  error: unknown, 
  context: string,
  userMessage: string = ERROR_MESSAGES.SERVER_ERROR
): { error: string } {
  // Log full details server-side
  console.error(`[${context}] Error:`, error)
  
  // Return safe message to user
  return { error: userMessage }
}

/**
 * Create a safe error response with status code
 */
export function safeErrorResponse(
  error: unknown,
  context: string,
  userMessage: string = ERROR_MESSAGES.SERVER_ERROR,
  status: number = 500
): Response {
  console.error(`[${context}] Error:`, error)
  
  return Response.json(
    { error: userMessage },
    { status }
  )
}
