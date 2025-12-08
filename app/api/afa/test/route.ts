import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      message: "AFA API is deployed and working",
    },
    { status: 200 }
  )
}

export async function POST(request: NextRequest) {
  return NextResponse.json(
    {
      status: "ok",
      method: "POST",
      timestamp: new Date().toISOString(),
      message: "AFA submit endpoint is ready",
    },
    { status: 200 }
  )
}
