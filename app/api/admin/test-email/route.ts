import { NextRequest, NextResponse } from "next/server"
import { sendEmail } from "@/lib/email-service"

/**
 * POST /api/admin/test-email
 * Test email sending (no auth for testing)
 * 
 * Body:
 * {
 *   "to": "test@example.com"
 * }
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { to } = body

        if (!to) {
            return NextResponse.json(
                { error: "Email address required" },
                { status: 400 }
            )
        }

        // Send test email
        const result = await sendEmail({
            to: [{ email: to, name: "Test Recipient" }],
            subject: "Test Email from DataGod",
            htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #2563eb;">Email Provider Test</h1>
          <p>This is a test email to verify your email configuration.</p>
          
          <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h2 style="margin-top: 0;">Configuration Details:</h2>
            <p><strong>Provider:</strong> ${process.env.EMAIL_PROVIDER || 'brevo (default)'}</p>
            <p><strong>Sender:</strong> ${process.env.EMAIL_SENDER_NAME || 'DataGod'} &lt;${process.env.EMAIL_SENDER_ADDRESS || 'noreply@datagod.com'}&gt;</p>
            <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          </div>

          <p>If you received this email, your email provider is configured correctly! ✅</p>
          
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
          
          <p style="color: #6b7280; font-size: 14px;">
            This is a test email sent from the DataGod admin panel.
          </p>
        </div>
      `,
            textContent: `
Email Provider Test

This is a test email to verify your email configuration.

Configuration Details:
- Provider: ${process.env.EMAIL_PROVIDER || 'brevo (default)'}
- Sender: ${process.env.EMAIL_SENDER_NAME || 'DataGod'} <${process.env.EMAIL_SENDER_ADDRESS || 'noreply@datagod.com'}>
- Timestamp: ${new Date().toISOString()}

If you received this email, your email provider is configured correctly! ✅

---
This is a test email sent from the DataGod admin panel.
      `
        })

        if (result.success) {
            return NextResponse.json({
                success: true,
                message: "Test email sent successfully",
                messageId: result.messageId,
                provider: result.provider,
                sentTo: to,
            })
        } else {
            return NextResponse.json(
                {
                    success: false,
                    error: result.error,
                    provider: result.provider,
                },
                { status: 500 }
            )
        }
    } catch (error) {
        console.error("[Test Email] Error:", error)
        return NextResponse.json(
            { error: "Internal server error" },
            { status: 500 }
        )
    }
}

/**
 * GET /api/admin/test-email
 * Get current email configuration (no auth for testing)
 */
export async function GET(request: NextRequest) {
    try {
        // Verify admin access // Removed as per instruction
        // const { isAdmin, errorResponse } = await verifyAdminAccess(request) // Removed as per instruction
        // if (!isAdmin) { // Removed as per instruction
        //     return errorResponse // Removed as per instruction
        // } // Removed as per instruction

        return NextResponse.json({
            provider: process.env.EMAIL_PROVIDER || 'brevo (default)',
            senderName: process.env.EMAIL_SENDER_NAME || 'DataGod',
            senderEmail: process.env.EMAIL_SENDER_ADDRESS || 'noreply@datagod.com',
            brevoConfigured: !!process.env.BREVO_API_KEY,
            resendConfigured: !!process.env.RESEND_API_KEY,
        })
    } catch (error) {
        console.error("[Test Email Config] Error:", error)
        return NextResponse.json(
            { error: "Internal server error" },
            { status: 500 }
        )
    }
}
