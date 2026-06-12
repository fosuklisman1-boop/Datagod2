import { useEffect, useState } from "react"
import { Text, StyleSheet, Alert, Linking } from "react-native"
import { Screen, Card, Button, Muted } from "@/components/ui"
import { supabase } from "@/lib/supabase"
import { unregisterPush } from "@/lib/push"
import { colors } from "@/lib/theme"

export default function ProfileScreen() {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState("user")

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return
      setEmail(data.user.email ?? "")
      const { data: row } = await supabase
        .from("users")
        .select("full_name, role")
        .eq("id", data.user.id)
        .maybeSingle()
      if (row) {
        setName(row.full_name ?? "")
        setRole(row.role ?? "user")
      }
    })
  }, [])

  const logout = () => {
    Alert.alert("Log out", "Sign out of this device?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        // Local scope only — never revoke the user's sessions on other devices
        // (same rule as the web app). Push token is removed first so this
        // device stops receiving notifications for the account.
        onPress: async () => {
          await unregisterPush()
          supabase.auth.signOut({ scope: "local" })
        },
      },
    ])
  }

  return (
    <Screen title="Profile">
      <Card>
        <Text style={s.name}>{name || email}</Text>
        <Muted>{email}</Muted>
        <Muted>Account type: {role}</Muted>
      </Card>

      <Card>
        <Muted>
          Manage your shop, sub-agents, results checker and more on the full dashboard.
        </Muted>
        <Button
          label="Open Web Dashboard"
          variant="ghost"
          onPress={() => Linking.openURL("https://www.datagod.store/dashboard")}
        />
      </Card>

      <Button label="Log Out" variant="danger" onPress={logout} />
    </Screen>
  )
}

const s = StyleSheet.create({
  name: { color: colors.text, fontSize: 18, fontWeight: "800", marginBottom: 4 },
})
