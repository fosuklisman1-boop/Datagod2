/**
 * Rate limiting configuration for different endpoints
 * All times are in milliseconds
 */

export const RATE_LIMITS = {
    // Authentication
    SIGNUP: {
        maxRequests: 5,
        windowMs: 60 * 60 * 1000, // 1 hour
        message: 'Too many signup attempts. Please try again later.',
    },

    // Public endpoints
    PUBLIC_PACKAGES: {
        maxRequests: 60,
        windowMs: 60 * 1000, // 1 minute
        message: 'Too many requests. Please wait a moment.',
    },

    SUPPORT_CONFIG: {
        maxRequests: 60,
        windowMs: 60 * 1000, // 1 minute
        message: 'Too many requests. Please wait a moment.',
    },

    // Admin endpoints
    ADMIN_GENERAL: {
        maxRequests: 100,
        windowMs: 60 * 1000, // 1 minute
        message: 'Too many admin requests. Please slow down.',
    },

    ADMIN_HEAVY: {
        maxRequests: 20,
        windowMs: 60 * 1000, // 1 minute (for sync, bulk operations)
        message: 'Too many heavy operations. Please wait.',
    },

    // Webhooks (fallback - signature is primary protection)
    WEBHOOK: {
        maxRequests: 100,
        windowMs: 60 * 1000, // 1 minute
        message: 'Too many webhook requests.',
    },

    // User operations (non-order)
    USER_GENERAL: {
        maxRequests: 50,
        windowMs: 60 * 1000, // 1 minute
        message: 'Too many requests. Please slow down.',
    },

    WALLET_OPERATION: {
        maxRequests: 30,
        windowMs: 60 * 1000, // 1 minute
        message: 'Too many wallet operations. Please wait.',
    },

    // Search operations
    SEARCH: {
        maxRequests: 30,
        windowMs: 60 * 1000, // 1 minute
        message: 'Too many search requests. Please slow down.',
    },
} as const

/**
 * Endpoints that are EXEMPT from rate limiting
 * These are business-critical order and payment endpoints
 */
export const RATE_LIMIT_EXEMPT_PATHS = [
    // Order placement - NEVER block legitimate customers
    '/api/orders/purchase',
    '/api/orders/create-bulk',
    '/api/shop/orders/create',

    // Payment - Critical for revenue
    '/api/payments/initialize',
    '/api/payments/verify',

    // Fulfillment - Backend processing
    '/api/fulfillment/process-order',
    '/api/orders/fulfillment',
    '/api/orders/check-status',

    // Webhooks handle their own verification
    '/api/webhooks/paystack',
    '/api/webhooks/mtn',
    '/api/webhook/mtn',
] as const

/**
 * Check if a path is exempt from rate limiting
 */
export function isRateLimitExempt(path: string): boolean {
    return RATE_LIMIT_EXEMPT_PATHS.some(exemptPath => path.startsWith(exemptPath))
}

/**
 * Heavy admin operations (require stricter limits)
 */
export const HEAVY_ADMIN_OPERATIONS = [
    '/api/admin/sync-orders',
    '/api/admin/fix-failed-orders',
    '/api/admin/orders/bulk-update-status',
    '/api/admin/orders/download',
] as const

/**
 * Check if an admin path is a heavy operation
 */
export function isHeavyAdminOperation(path: string): boolean {
    return HEAVY_ADMIN_OPERATIONS.some(heavyPath => path.startsWith(heavyPath))
}

/**
 * Development mode bypass
 */
export function shouldBypassRateLimit(): boolean {
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true'
}
