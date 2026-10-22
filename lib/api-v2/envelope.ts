import { NextResponse } from "next/server"

export const API_VERSION = "2"

export type V2ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 502 | 503

export function successBody<T>(
  data: T,
  now: Date = new Date()
): { success: true; data: T; meta: { timestamp: string; version: string } } {
  return {
    success: true,
    data,
    meta: { timestamp: now.toISOString(), version: API_VERSION },
  }
}

export function errorBody(
  status: V2ErrorStatus,
  message: string
): { success: false; error: { code: number; message: string } } {
  return { success: false, error: { code: status, message } }
}

export function v2Response(status: number, body: object): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}
