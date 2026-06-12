import { useState } from "react"
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { supabase } from "@/lib/supabase"
import { colors } from "@/lib/theme"

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
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.container}
      >
        <Text style={styles.logo}>DATAGOD</Text>
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

        <TouchableOpacity style={styles.button} onPress={signIn} disabled={busy}>
          {busy ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.buttonText}>Sign In</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.hint}>
          New here? Create your account on www.datagod.store first.
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, justifyContent: "center", padding: 24 },
  logo: {
    color: colors.primary, fontSize: 28, fontWeight: "800",
    textAlign: "center", letterSpacing: 4,
  },
  heading: {
    color: colors.text, fontSize: 22, fontWeight: "700",
    textAlign: "center", marginTop: 24,
  },
  subtitle: { color: colors.textMuted, textAlign: "center", marginTop: 4, marginBottom: 28 },
  input: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: 12, color: colors.text, padding: 14, marginBottom: 12, fontSize: 16,
  },
  error: { color: colors.danger, marginBottom: 12, textAlign: "center" },
  button: {
    backgroundColor: colors.primary, borderRadius: 12, padding: 16,
    alignItems: "center", marginTop: 4,
  },
  buttonText: { color: colors.primaryForeground, fontWeight: "700", fontSize: 16 },
  hint: { color: colors.textMuted, textAlign: "center", marginTop: 24, fontSize: 12 },
})
