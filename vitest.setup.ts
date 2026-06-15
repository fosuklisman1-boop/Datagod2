// Placeholder env so modules that build a Supabase client at import time (e.g.
// lib/whatsapp-bot/log-message.ts) don't throw during a unit-test import. No
// real connection is made — these tests only exercise pure logic.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321"
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key"
