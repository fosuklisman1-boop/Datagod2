import { createClient } from "@supabase/supabase-js"
import { Platform } from "react-native"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config"

// React Native Supabase client: sessions persist in AsyncStorage and refresh
// automatically while the app runs. On web (incl. the static-export prerender,
// which runs in Node without native modules) fall back to supabase's default
// storage instead of AsyncStorage.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    ...(Platform.OS !== "web" ? { storage: AsyncStorage } : {}),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})
