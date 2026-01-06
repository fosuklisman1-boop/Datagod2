import { NextRequest, NextResponse } from "next/server"
import {
  mtnConfig,
  validateMTNConfig,
  performHealthCheck,
  getMetrics,
  getCircuitBreakerStatus,
  getRateLimitStatus,
} from "@/lib/mtn-production-config"
import { checkMTNBalance } from "@/lib/mtn-fulfillment"

/**
 * GET /api/health/mtn
 * 
 * Production health check endpoint for MTN integration.
 * Returns comprehensive health status for monitoring systems.
 * 
 * Response codes:
 * - 200: Healthy
 * - 207: Degraded (partial functionality)
 * - 503: Unhealthy (service unavailable)
 */
export async function GET(request: NextRequest) {
  try {
    // Check for optional verbose mode
    const verbose = request.nextUrl.searchParams.get("verbose") === "true"

    // Validate configuration
    const configValidation = validateMTNConfig(mtnConfig)
    if (!configValidation.valid) {
      return NextResponse.json(
        {
          status: "unhealthy",
          error: "Invalid configuration",
          details: configValidation.errors,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      )
    }

    // Perform full health check
    const health = await performHealthCheck(mtnConfig, checkMTNBalance)

    // Build response
    const response: Record<string, unknown> = {
      status: health.status,
      timestamp: health.timestamp,
      checks: health.checks,
    }

    // Add verbose metrics if requested
    if (verbose) {
      response.metrics = health.metrics
      response.circuitBreaker = getCircuitBreakerStatus()
      response.rateLimit = getRateLimitStatus(mtnConfig)
      response.config = {
        baseUrl: mtnConfig.apiBaseUrl,
        timeout: mtnConfig.requestTimeout,
        maxRetries: mtnConfig.maxRetries,
        rateLimitPerMinute: mtnConfig.rateLimitPerMinute,
        balanceAlertThreshold: mtnConfig.balanceAlertThreshold,
      }
    }

    // Determine HTTP status code based on health
    let statusCode = 200
    if (health.status === "degraded") {
      statusCode = 207
    } else if (health.status === "unhealthy") {
      statusCode = 503
    }

    return NextResponse.json(response, { status: statusCode })
  } catch (error) {
    console.error("[MTN Health] Error:", error)
    return NextResponse.json(
      {
        status: "unhealthy",
        error: "Health check failed",
        details: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    )
  }
}

/**
 * HEAD /api/health/mtn
 * 
 * Lightweight health check for load balancers.
 * Returns only status code without body.
 */
export async function HEAD(request: NextRequest) {
  try {
    const configValidation = validateMTNConfig(mtnConfig)
    if (!configValidation.valid) {
      return new NextResponse(null, { status: 503 })
    }

    const circuitBreaker = getCircuitBreakerStatus()
    if (circuitBreaker.isOpen) {
      return new NextResponse(null, { status: 503 })
    }

    return new NextResponse(null, { status: 200 })
  } catch {
    return new NextResponse(null, { status: 503 })
  }
}
