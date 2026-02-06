import { NextRequest } from 'next/server'

/**
 * In-memory rate limiter using token bucket algorithm
 * Automatically cleans up old entries to prevent memory leaks
 */

interface RateLimitEntry {
    requests: number[]
    lastCleanup: number
}

// Store: Map<identifier, RateLimitEntry>
const rateLimitStore = new Map<string, RateLimitEntry>()

// Cleanup interval: 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
let lastGlobalCleanup = Date.now()

/**
 * Clean up old entries from the rate limit store
 */
function cleanup() {
    const now = Date.now()
    const ENTRY_MAX_AGE = 60 * 60 * 1000 // 1 hour

    for (const [key, entry] of rateLimitStore.entries()) {
        // Remove entries that haven't been accessed in over an hour
        if (now - entry.lastCleanup > ENTRY_MAX_AGE) {
            rateLimitStore.delete(key)
        }
    }

    lastGlobalCleanup = now
}

/**
 * Check if request should be rate limited
 * @param identifier - Unique identifier (IP address, user ID, etc)
 * @param maxRequests - Maximum number of requests allowed
 * @param windowMs - Time window in milliseconds
 * @returns Object with allowed status and remaining requests
 */
export function checkRateLimit(
    identifier: string,
    maxRequests: number,
    windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now()
    const windowStart = now - windowMs

    // Periodic global cleanup
    if (now - lastGlobalCleanup > CLEANUP_INTERVAL_MS) {
        cleanup()
    }

    // Get or create entry
    let entry = rateLimitStore.get(identifier)
    if (!entry) {
        entry = { requests: [], lastCleanup: now }
        rateLimitStore.set(identifier, entry)
    }

    // Filter out old requests outside the window
    entry.requests = entry.requests.filter(timestamp => timestamp > windowStart)
    entry.lastCleanup = now

    // Check if limit exceeded
    if (entry.requests.length >= maxRequests) {
        const oldestRequest = entry.requests[0]
        const resetAt = oldestRequest + windowMs

        return {
            allowed: false,
            remaining: 0,
            resetAt,
        }
    }

    // Record this request
    entry.requests.push(now)

    return {
        allowed: true,
        remaining: maxRequests - entry.requests.length,
        resetAt: now + windowMs,
    }
}

/**
 * Get client identifier from request (IP address or authenticated user ID)
 */
export function getClientIdentifier(request: NextRequest, userId?: string): string {
    if (userId) {
        return `user:${userId}`
    }

    // Try to get IP from various headers (for proxies/load balancers)
    const forwardedFor = request.headers.get('x-forwarded-for')
    const realIp = request.headers.get('x-real-ip')
    const cfConnectingIp = request.headers.get('cf-connecting-ip')

    const ip = cfConnectingIp || realIp || forwardedFor?.split(',')[0] || 'unknown'

    return `ip:${ip}`
}

/**
 * Helper to apply rate limiting to a route
 * @param request - NextRequest object
 * @param endpointName - Name of endpoint for logging
 * @param maxRequests - Maximum requests allowed
 * @param windowMs - Time window in milliseconds
 * @param userId - Optional user ID for authenticated requests
 */
export async function applyRateLimit(
    request: NextRequest,
    endpointName: string,
    maxRequests: number,
    windowMs: number,
    userId?: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const identifier = getClientIdentifier(request, userId)
    const result = checkRateLimit(identifier, maxRequests, windowMs)

    if (!result.allowed) {
        console.warn(`[RATE-LIMIT] Blocked request to ${endpointName}`, {
            identifier,
            limit: maxRequests,
            window: `${windowMs / 1000}s`,
        })
    }

    return result
}

/**
 * Reset rate limit for a specific identifier (for testing or admin override)
 */
export function resetRateLimit(identifier: string): void {
    rateLimitStore.delete(identifier)
}

/**
 * Get current rate limit status for an identifier
 */
export function getRateLimitStatus(
    identifier: string,
    maxRequests: number,
    windowMs: number
): { current: number; limit: number; remaining: number } {
    const now = Date.now()
    const windowStart = now - windowMs

    const entry = rateLimitStore.get(identifier)
    if (!entry) {
        return { current: 0, limit: maxRequests, remaining: maxRequests }
    }

    const recentRequests = entry.requests.filter(t => t > windowStart)
    return {
        current: recentRequests.length,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - recentRequests.length),
    }
}
