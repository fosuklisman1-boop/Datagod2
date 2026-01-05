import { NextResponse } from 'next/server';

// Store subscriptions in a simple in-memory map or database
// For production, use a database like Supabase
const subscriptions = new Map();

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const subscription = await request.json();

    if (!subscription || !subscription.endpoint) {
      return NextResponse.json(
        { error: 'Invalid subscription' },
        { status: 400 }
      );
    }

    // Store subscription
    subscriptions.set(subscription.endpoint, subscription);

    // In production, save to database
    console.log('[Push API] Subscription saved:', subscription.endpoint);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Push API] Subscription error:', error);
    return NextResponse.json(
      { error: 'Failed to save subscription' },
      { status: 500 }
    );
  }
}
