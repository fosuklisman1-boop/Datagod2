import { createClient } from "@supabase/supabase-js"
import * as dotenv from "dotenv"

dotenv.config()

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

async function check() {
  console.log("Checking Admin Settings...")
  const { data: settings } = await supabase
    .from("admin_settings")
    .select("key, value")
    .like("key", "airtime_fee_%")
  console.log("Settings:", JSON.stringify(settings, null, 2))

  console.log("Checking Airtime Orders...")
  const { data: orders, count } = await supabase
    .from("airtime_orders")
    .select("*", { count: "exact" })
    .limit(5)
  console.log("Orders Count:", count)
  console.log("Sample Orders:", JSON.stringify(orders, null, 2))
}

check()
