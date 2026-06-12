// Central config. EXPO_PUBLIC_* env vars override at build time; the fallbacks
// are the production values (the Supabase anon key is public by design).
export const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL || "https://riijesduargxlzxuperj.supabase.co"

export const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpaWplc2R1YXJneGx6eHVwZXJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQwODU5NzEsImV4cCI6MjA3OTY2MTk3MX0.UA1Djt2pQHOa9hV6UJ6lOaJNSwYB8jZVrFzU_n0ISvk"

// The Next.js backend all API calls go to.
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://www.datagod.store"
