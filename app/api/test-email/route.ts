
import { NextRequest, NextResponse } from "next/server";
import { sendEmail } from "@/lib/email-service";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { email, name } = body;

        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const result = await sendEmail({
            to: [{ email, name }],
            subject: "Test Email from DataGod API",
            htmlContent: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h1>Email Test Successful! 🎉</h1>
          <p>This is a test email triggered from the test endpoint.</p>
          <p>Your email service (Brevo) is configured correctly.</p>
          <hr>
          <p style="color: #666; font-size: 12px;">Sent from DataGod API</p>
        </div>
      `,
            type: "test_email"
        });

        if (result.success) {
            return NextResponse.json({ message: "Email sent successfully", result });
        } else {
            return NextResponse.json({ error: "Failed to send email", details: result.error }, { status: 500 });
        }

    } catch (error: any) {
        console.error("Test Email Error:", error);
        return NextResponse.json({ error: "Internal Server Error", details: error.message }, { status: 500 });
    }
}
