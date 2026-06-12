import { useState } from "react"
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { LinearGradient } from "expo-linear-gradient"
import { supabase } from "@/lib/supabase"
import { colors, radius, purpleGradient } from "@/lib/theme"

export default function LoginScreen() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const signIn = async () => {
    if (!email.trim() || !password) {
      setError("Enter your email and password")
      return
    }
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })
    setBusy(false)
    if (err) setError(err.message)
    // On success the root layout's auth gate routes to the tabs.
  }

  return (
    <View style={styles.root}>
      {/* Purple brand panel, like the web login's gradient side panel. */}
      <LinearGradient colors={purpleGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.brand}>
            <Text style={styles.logo}>DATAGOD</Text>
            <Text style={styles.tagline}>Buy data & airtime in seconds — all in one place.</Text>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.container}
      >
        <Text style={styles.heading}>Sign in</Text>
        <Text style={styles.subtitle}>Welcome back — please enter your details.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={signIn}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity onPress={signIn} disabled={busy}>
          <LinearGradient
            colors={purpleGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.button, busy && { opacity: 0.6 }]}
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.buttonText}>Sign In</Text>
            )}
          </LinearGradient>
        </TouchableOpacity>

        <Text style={styles.hint}>
          New here? Create your account on www.datagod.store first.
        </Text>
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  brand: { paddingHorizontal: 24, paddingTop: 28, paddingBottom: 36 },
  logo: { color: "#ffffff", fontSize: 28, fontWeight: "800", letterSpacing: 4 },
  tagline: { color: "rgba(255,255,255,0.85)", marginTop: 8, fontSize: 13 },
  container: { flex: 1, justifyContent: "center", padding: 24, marginTop: -16 },
  heading: { color: colors.text, fontSize: 22, fontWeight: "800" },
  subtitle: { color: colors.textMuted, marginTop: 4, marginBottom: 24 },
  input: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.md, color: colors.text, padding: 14, marginBottom: 12, fontSize: 16,
  },
  error: { color: colors.danger, marginBottom: 12, textAlign: "center" },
  button: {
    borderRadius: radius.full, padding: 16, alignItems: "center", marginTop: 4,
    shadowColor: colors.primary, shadowOpacity: 0.3, shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  buttonText: { color: colors.primaryForeground, fontWeight: "700", fontSize: 16 },
  hint: { color: colors.textMuted, textAlign: "center", marginTop: 24, fontSize: 12 },
})
