import { NextRequest } from "next/server"
import { POST as primaryPOST, GET as primaryGET } from "../../webhooks/mtn/route"

/**
 * POST /api/webhook/mtn
 * Wrapper for the primary MTN webhook handler
 */
export async function POST(request: NextRequest) {
  return primaryPOST(request)
}

/**
 * GET /api/webhook/mtn
 * Wrapper for the primary MTN webhook handler
 */
export async function GET(request: NextRequest) {
  return primaryGET(request)
}
