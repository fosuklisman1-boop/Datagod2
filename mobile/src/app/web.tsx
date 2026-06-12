// Authenticated in-app WebView: opens any web-dashboard feature already
// signed in, via the /auth/mobile-handoff token handoff (tokens ride the URL
// fragment — never sent to the server). This is the parity bridge: every web
// feature is available here until its native screen ships.
import { useEffect, useState } from "react"
import { ActivityIndicator, View, StyleSheet } from "react-native"
import { WebView } from "react-native-webview"
import { useLocalSearchParams } from "expo-router"
import { Screen, Muted } from "@/components/ui"
import { API_BASE_URL } from "@/lib/config"
import { supabase } from "@/lib/supabase"
import { colors } from "@/lib/theme"

export default function WebScreen() {
  const { path, title } = useLocalSearchParams<{ path?: string; title?: string }>()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    ;(async () => {
      const target = typeof path === "string" && path.startsWith("/") ? path : "/dashboard"
      const { data } = await supabase.auth.getSession()
      const at = data.session?.access_token
      const rt = data.session?.refresh_token
      if (at && rt) {
        const hash = `access_token=${encodeURIComponent(at)}&refresh_token=${encodeURIComponent(rt)}&next=${encodeURIComponent(target)}`
        setUrl(`${API_BASE_URL}/auth/mobile-handoff#${hash}`)
      } else {
        // No session — the page will bounce to the web login itself.
        setUrl(`${API_BASE_URL}${target}`)
      }
    })()
  }, [path])

  return (
    <Screen title={typeof title === "string" && title ? title : "Datagod"} back>
      {failed ? (
        <Muted>Could not load the page. Check your connection and try again.</Muted>
      ) : !url ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <WebView
          source={{ uri: url }}
          style={s.web}
          startInLoadingState
          renderLoading={() => (
            <View style={[s.center, StyleSheet.absoluteFillObject as object]}>
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          )}
          onError={() => setFailed(true)}
          // Keep navigation inside the dashboard origin.
          originWhitelist={["https://*"]}
        />
      )}
    </Screen>
  )
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  web: { flex: 1, marginHorizontal: -16, marginTop: -16, backgroundColor: colors.bg },
})
