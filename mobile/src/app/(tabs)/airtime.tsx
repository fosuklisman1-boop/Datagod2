import { useEffect, useState } from "react"
import { Text, View, TouchableOpacity, StyleSheet, Alert, ScrollView } from "react-native"
import { Screen, Card, Button, Field, Muted } from "@/components/ui"
import { purchaseAirtime, getWalletBalance } from "@/lib/datagod"
import { isValidGhanaMobile, normalizeGhanaPhone } from "@/lib/phone-format"
import { colors, networkColors } from "@/lib/theme"

const NETWORKS = ["MTN", "Telecel", "AirtelTigo"]

export default function AirtimeScreen() {
  const [network, setNetwork] = useState("MTN")
  const [phone, setPhone] = useState("")
  const [amount, setAmount] = useState("")
  const [balance, setBalance] = useState(0)
  const [busy, setBusy] = useState(false)

  const loadBalance = () => getWalletBalance().then((w) => setBalance(w.balance)).catch(() => {})
  useEffect(() => {
    loadBalance()
  }, [])

  const buy = async () => {
    const normalized = normalizeGhanaPhone(phone)
    const amt = parseFloat(amount)
    if (!normalized || !isValidGhanaMobile(phone)) {
      Alert.alert("Invalid number", "Enter a valid Ghana mobile number")
      return
    }
    if (!amt || amt <= 0) {
      Alert.alert("Invalid amount", "Enter the airtime amount in GHS")
      return
    }
    if (amt > balance) {
      Alert.alert("Insufficient balance", `You need GHS ${amt.toFixed(2)} but have GHS ${balance.toFixed(2)}`)
      return
    }
    setBusy(true)
    try {
      const res = await purchaseAirtime(network, normalized, amt)
      if (typeof res.newBalance === "number") setBalance(res.newBalance)
      setPhone("")
      setAmount("")
      Alert.alert("Airtime sent!", `GHS ${amt.toFixed(2)} ${network} airtime to ${normalized}.`)
      loadBalance()
    } catch (e: any) {
      Alert.alert("Purchase failed", e?.message ?? "Please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="Buy Airtime">
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Muted>Wallet: GHS {balance.toFixed(2)}</Muted>

        <View style={s.netRow}>
          {NETWORKS.map((n) => (
            <TouchableOpacity
              key={n}
              style={[s.net, network === n && s.netActive]}
              onPress={() => setNetwork(n)}
            >
              <View style={[s.dot, { backgroundColor: networkColors[n] ?? colors.primary }]} />
              <Text style={[s.netText, network === n && { color: colors.primaryForeground }]}>{n}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Card>
          <Field
            label="Recipient phone number"
            placeholder="0241234567"
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
          />
          <Field
            label="Amount (GHS)"
            placeholder="10"
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
          />
          <Button label="Pay from Wallet" onPress={buy} busy={busy} />
        </Card>
      </ScrollView>
    </Screen>
  )
}

const s = StyleSheet.create({
  netRow: { flexDirection: "row", gap: 8, marginVertical: 14 },
  net: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    borderColor: colors.border, borderWidth: 1, borderRadius: 12,
    paddingVertical: 12, backgroundColor: colors.card,
  },
  netActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  netText: { color: colors.text, fontWeight: "700", fontSize: 13 },
  dot: { width: 8, height: 8, borderRadius: 4 },
})
