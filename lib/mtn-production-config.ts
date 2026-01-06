/**
 * MTN Production Configuration
 * 
 * This module provides production-ready configuration validation,
 * monitoring, and operational utilities for MTN integration.
 */

// ============================================
// Environment Configuration
// ============================================

export interface MTNConfig {
  apiKey: string
  apiBaseUrl: string
  webhookSecret: string
  requestTimeout: number
  maxRetries: number
  retryBackoffBase: number
  circuitBreakerThreshold: number
  circuitBreakerResetTime: number
  rateLimitPerMinute: number
  balanceAlertThreshold: number
  enableAutoFulfillment: boolean
}

/**
 * Validate and load MTN configuration from environment
 */
export function loadMTNConfig(): MTNConfig {
  const config: MTNConfig = {
    apiKey: process.env.MTN_API_KEY || "",
    apiBaseUrl: process.env.MTN_API_BASE_URL || "https://sykesofficial.net",
    webhookSecret: process.env.MTN_WEBHOOK_SECRET || process.env.MTN_API_KEY || "",
    requestTimeout: parseInt(process.env.MTN_REQUEST_TIMEOUT || "30000", 10),
    maxRetries: parseInt(process.env.MTN_MAX_RETRIES || "4", 10),
    retryBackoffBase: parseInt(process.env.MTN_RETRY_BACKOFF_BASE || "5000", 10),
    circuitBreakerThreshold: parseInt(process.env.MTN_CIRCUIT_BREAKER_THRESHOLD || "5", 10),
    circuitBreakerResetTime: parseInt(process.env.MTN_CIRCUIT_BREAKER_RESET || "60000", 10),
    rateLimitPerMinute: parseInt(process.env.MTN_RATE_LIMIT_PER_MINUTE || "60", 10),
    balanceAlertThreshold: parseFloat(process.env.MTN_BALANCE_ALERT_THRESHOLD || "500"),
    enableAutoFulfillment: process.env.MTN_AUTO_FULFILLMENT_DEFAULT === "true",
  }

  return config
}

/**
 * Validate required MTN configuration at startup
 */
export function validateMTNConfig(config: MTNConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!config.apiKey) {
    errors.push("MTN_API_KEY is required")
  } else if (config.apiKey.length < 10) {
    errors.push("MTN_API_KEY appears invalid (too short)")
  }

  if (!config.apiBaseUrl) {
    errors.push("MTN_API_BASE_URL is required")
  } else if (!config.apiBaseUrl.startsWith("https://")) {
    errors.push("MTN_API_BASE_URL must use HTTPS in production")
  }

  if (config.requestTimeout < 5000 || config.requestTimeout > 120000) {
    errors.push("MTN_REQUEST_TIMEOUT should be between 5000 and 120000 ms")
  }

  if (config.maxRetries < 1 || config.maxRetries > 10) {
    errors.push("MTN_MAX_RETRIES should be between 1 and 10")
  }

  if (config.rateLimitPerMinute < 1 || config.rateLimitPerMinute > 1000) {
    errors.push("MTN_RATE_LIMIT_PER_MINUTE should be between 1 and 1000")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// ============================================
// Circuit Breaker Pattern
// ============================================

interface CircuitBreakerState {
  failures: number
  lastFailure: number
  isOpen: boolean
  openedAt: number
}

const circuitBreaker: CircuitBreakerState = {
  failures: 0,
  lastFailure: 0,
  isOpen: false,
  openedAt: 0,
}

/**
 * Check if circuit breaker is open (should block requests)
 */
export function isCircuitBreakerOpen(config: MTNConfig): boolean {
  if (!circuitBreaker.isOpen) {
    return false
  }

  // Check if reset time has passed
  const now = Date.now()
  if (now - circuitBreaker.openedAt > config.circuitBreakerResetTime) {
    // Half-open: allow a test request
    circuitBreaker.isOpen = false
    circuitBreaker.failures = 0
    console.log("[MTN] Circuit breaker reset - allowing requests")
    return false
  }

  return true
}

/**
 * Record a successful request (resets circuit breaker)
 */
export function recordSuccess(): void {
  circuitBreaker.failures = 0
  circuitBreaker.isOpen = false
}

/**
 * Record a failed request (may open circuit breaker)
 */
export function recordFailure(config: MTNConfig): void {
  circuitBreaker.failures++
  circuitBreaker.lastFailure = Date.now()

  if (circuitBreaker.failures >= config.circuitBreakerThreshold) {
    circuitBreaker.isOpen = true
    circuitBreaker.openedAt = Date.now()
    console.error(`[MTN] Circuit breaker OPENED after ${circuitBreaker.failures} failures`)
  }
}

/**
 * Get current circuit breaker status
 */
export function getCircuitBreakerStatus(): {
  isOpen: boolean
  failures: number
  lastFailure: number | null
  openedAt: number | null
} {
  return {
    isOpen: circuitBreaker.isOpen,
    failures: circuitBreaker.failures,
    lastFailure: circuitBreaker.lastFailure || null,
    openedAt: circuitBreaker.openedAt || null,
  }
}

// ============================================
// Rate Limiting
// ============================================

interface RateLimitState {
  requests: number[]
}

const rateLimit: RateLimitState = {
  requests: [],
}

/**
 * Check if rate limit is exceeded
 */
export function isRateLimited(config: MTNConfig): boolean {
  const now = Date.now()
  const oneMinuteAgo = now - 60000

  // Clean up old requests
  rateLimit.requests = rateLimit.requests.filter((t) => t > oneMinuteAgo)

  return rateLimit.requests.length >= config.rateLimitPerMinute
}

/**
 * Record a request for rate limiting
 */
export function recordRequest(): void {
  rateLimit.requests.push(Date.now())
}

/**
 * Get current rate limit status
 */
export function getRateLimitStatus(config: MTNConfig): {
  currentRequests: number
  limit: number
  remainingRequests: number
  resetIn: number
} {
  const now = Date.now()
  const oneMinuteAgo = now - 60000

  // Clean up old requests
  rateLimit.requests = rateLimit.requests.filter((t) => t > oneMinuteAgo)

  const oldestRequest = rateLimit.requests[0]
  const resetIn = oldestRequest ? Math.max(0, oldestRequest + 60000 - now) : 0

  return {
    currentRequests: rateLimit.requests.length,
    limit: config.rateLimitPerMinute,
    remainingRequests: Math.max(0, config.rateLimitPerMinute - rateLimit.requests.length),
    resetIn,
  }
}

// ============================================
// Metrics & Monitoring
// ============================================

interface MTNMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  averageLatency: number
  lastRequestAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  uptime: number
  startedAt: number
}

const metrics: MTNMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  averageLatency: 0,
  lastRequestAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  uptime: 0,
  startedAt: Date.now(),
}

const latencies: number[] = []
const MAX_LATENCY_SAMPLES = 100

/**
 * Record request metrics
 */
export function recordMetrics(success: boolean, latencyMs: number): void {
  metrics.totalRequests++
  metrics.lastRequestAt = Date.now()

  if (success) {
    metrics.successfulRequests++
    metrics.lastSuccessAt = Date.now()
  } else {
    metrics.failedRequests++
    metrics.lastFailureAt = Date.now()
  }

  // Track latency
  latencies.push(latencyMs)
  if (latencies.length > MAX_LATENCY_SAMPLES) {
    latencies.shift()
  }
  metrics.averageLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length
}

/**
 * Get current metrics
 */
export function getMetrics(): MTNMetrics & {
  successRate: number
  p95Latency: number
  p99Latency: number
} {
  const now = Date.now()
  const successRate =
    metrics.totalRequests > 0
      ? (metrics.successfulRequests / metrics.totalRequests) * 100
      : 100

  // Calculate percentiles
  const sortedLatencies = [...latencies].sort((a, b) => a - b)
  const p95Index = Math.floor(sortedLatencies.length * 0.95)
  const p99Index = Math.floor(sortedLatencies.length * 0.99)

  return {
    ...metrics,
    uptime: now - metrics.startedAt,
    successRate: Math.round(successRate * 100) / 100,
    p95Latency: sortedLatencies[p95Index] || 0,
    p99Latency: sortedLatencies[p99Index] || 0,
  }
}

// ============================================
// Health Check
// ============================================

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy"
  checks: {
    api: { status: "up" | "down"; latency?: number; error?: string }
    circuitBreaker: { status: "closed" | "open"; failures: number }
    rateLimit: { status: "ok" | "warning" | "exceeded"; usage: number; limit: number }
    balance: { status: "ok" | "low" | "critical"; amount?: number; threshold: number }
  }
  metrics: {
    successRate: number
    averageLatency: number
    totalRequests: number
  }
  timestamp: string
}

/**
 * Perform comprehensive health check
 */
export async function performHealthCheck(
  config: MTNConfig,
  checkBalance: () => Promise<number | null>
): Promise<HealthStatus> {
  const checks: HealthStatus["checks"] = {
    api: { status: "down" },
    circuitBreaker: {
      status: circuitBreaker.isOpen ? "open" : "closed",
      failures: circuitBreaker.failures,
    },
    rateLimit: {
      status: "ok",
      usage: rateLimit.requests.length,
      limit: config.rateLimitPerMinute,
    },
    balance: {
      status: "ok",
      threshold: config.balanceAlertThreshold,
    },
  }

  // Rate limit check
  const rlStatus = getRateLimitStatus(config)
  if (rlStatus.remainingRequests === 0) {
    checks.rateLimit.status = "exceeded"
  } else if (rlStatus.remainingRequests < config.rateLimitPerMinute * 0.2) {
    checks.rateLimit.status = "warning"
  }

  // API health check (ping)
  try {
    const start = Date.now()
    const response = await fetch(`${config.apiBaseUrl}/api/health`, {
      method: "GET",
      headers: { "X-API-KEY": config.apiKey },
      signal: AbortSignal.timeout(5000),
    })
    const latency = Date.now() - start

    if (response.ok) {
      checks.api = { status: "up", latency }
    } else {
      checks.api = { status: "down", error: `HTTP ${response.status}` }
    }
  } catch (error) {
    checks.api = {
      status: "down",
      error: error instanceof Error ? error.message : "Connection failed",
    }
  }

  // Balance check
  try {
    const balance = await checkBalance()
    if (balance !== null) {
      checks.balance.amount = balance
      if (balance < config.balanceAlertThreshold * 0.25) {
        checks.balance.status = "critical"
      } else if (balance < config.balanceAlertThreshold) {
        checks.balance.status = "low"
      }
    }
  } catch {
    // Balance check optional
  }

  // Determine overall status
  let status: HealthStatus["status"] = "healthy"
  if (
    checks.api.status === "down" ||
    checks.circuitBreaker.status === "open" ||
    checks.balance.status === "critical"
  ) {
    status = "unhealthy"
  } else if (
    checks.rateLimit.status === "warning" ||
    checks.balance.status === "low"
  ) {
    status = "degraded"
  }

  const currentMetrics = getMetrics()

  return {
    status,
    checks,
    metrics: {
      successRate: currentMetrics.successRate,
      averageLatency: currentMetrics.averageLatency,
      totalRequests: currentMetrics.totalRequests,
    },
    timestamp: new Date().toISOString(),
  }
}

// ============================================
// Structured Logging
// ============================================

export type LogLevel = "debug" | "info" | "warn" | "error"

interface LogEntry {
  timestamp: string
  level: LogLevel
  component: string
  message: string
  data?: Record<string, unknown>
  traceId?: string
}

/**
 * Create structured log entry
 */
export function log(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>,
  traceId?: string
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component: `MTN.${component}`,
    message,
    data,
    traceId,
  }

  const logLine = JSON.stringify(entry)

  switch (level) {
    case "debug":
      if (process.env.NODE_ENV === "development") {
        console.debug(logLine)
      }
      break
    case "info":
      console.log(logLine)
      break
    case "warn":
      console.warn(logLine)
      break
    case "error":
      console.error(logLine)
      break
  }
}

/**
 * Generate trace ID for request tracking
 */
export function generateTraceId(): string {
  return `mtn-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

// ============================================
// Error Classification
// ============================================

export type MTNErrorType =
  | "NETWORK_ERROR"
  | "TIMEOUT_ERROR"
  | "AUTH_ERROR"
  | "VALIDATION_ERROR"
  | "RATE_LIMIT_ERROR"
  | "BALANCE_ERROR"
  | "API_ERROR"
  | "UNKNOWN_ERROR"

export interface ClassifiedError {
  type: MTNErrorType
  message: string
  retryable: boolean
  userMessage: string
  originalError?: Error
}

/**
 * Classify error for proper handling
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()

    if (message.includes("timeout") || message.includes("aborted")) {
      return {
        type: "TIMEOUT_ERROR",
        message: error.message,
        retryable: true,
        userMessage: "Request timed out. Please try again.",
        originalError: error,
      }
    }

    if (message.includes("network") || message.includes("fetch") || message.includes("econnrefused")) {
      return {
        type: "NETWORK_ERROR",
        message: error.message,
        retryable: true,
        userMessage: "Network error. Please check your connection.",
        originalError: error,
      }
    }

    if (message.includes("401") || message.includes("unauthorized") || message.includes("authentication")) {
      return {
        type: "AUTH_ERROR",
        message: error.message,
        retryable: false,
        userMessage: "Authentication failed. Please contact support.",
        originalError: error,
      }
    }

    if (message.includes("429") || message.includes("rate limit") || message.includes("too many")) {
      return {
        type: "RATE_LIMIT_ERROR",
        message: error.message,
        retryable: true,
        userMessage: "Too many requests. Please wait and try again.",
        originalError: error,
      }
    }

    if (message.includes("balance") || message.includes("insufficient")) {
      return {
        type: "BALANCE_ERROR",
        message: error.message,
        retryable: false,
        userMessage: "Insufficient balance. Please contact support.",
        originalError: error,
      }
    }

    if (message.includes("400") || message.includes("invalid") || message.includes("validation")) {
      return {
        type: "VALIDATION_ERROR",
        message: error.message,
        retryable: false,
        userMessage: "Invalid request. Please check your input.",
        originalError: error,
      }
    }
  }

  return {
    type: "UNKNOWN_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    userMessage: "An unexpected error occurred. Please try again.",
    originalError: error instanceof Error ? error : undefined,
  }
}

// ============================================
// Export Configuration
// ============================================

export const mtnConfig = loadMTNConfig()
