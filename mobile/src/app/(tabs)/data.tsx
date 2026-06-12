import { useEffect, useMemo, useState } from "react"
import {
  FlatList, Text, View, TouchableOpacity, StyleSheet, Modal, Alert,
} from "react-native"
import { Screen, Card, Button, Field, Muted, ErrorText } from "@/components/ui"
import { listPackages, purchaseData, getWalletBalance, type DataPackage } from "@/lib/datagod"
import { isValidGhanaMobile, normalizeGhanaPhone } from "@/lib/phone-format"
import { colors, networkColors, radius, cardShadow } from "@/lib/theme"

export default function BuyDataScreen() {
  const [packages, setPackages] = useState<DataPackage[]>([])
  const [network, setNetwork] = useState("All")
  const [balance, setBalance] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<DataPackage | null>(null)
  const [phone, setPhone] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([listPackages(), getWalletBalance()])
      .then(([pkgs, w]) => {
        setPackages(pkgs)
        setBalance(w.balance)
      })
      .catch((e) => setError(e?.message ?? "Failed to load packages"))
  }, [])

  const networks = useMemo(
    () => ["All", ...Array.from(new Set(packages.map((p) => p.network)))],
    [packages],
  )
  const visible = useMemo(
    () => (network === "All" ? packages : packages.filter((p) => p.network === network)),
    [packages, network],
  )

  const buy = async () => {
    if (!selected) return
    const normalized = normalizeGhanaPhone(phone)
    if (!normalized || !isValidGhanaMobile(phone)) {
      Alert.alert("Invalid number", "Enter a valid Ghana mobile number (e.g. 0241234567)")
      return
    }
    setBusy(true)
    try {
      const res = await purchaseData(selected, normalized)
      setBalance(res.newBalance)
      setSelected(null)
      setPhone("")
      Alert.alert(
        "Order placed!",
        `${selected.network} ${selected.size} for ${normalized}.\nNew balance: GHS ${res.newBalance.toFixed(2)}`,
      )
    } catch (e: any) {
      Alert.alert("Purchase failed", e?.message ?? "Please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="Buy Data">
      <Muted>Wallet: GHS {balance.toFixed(2)}</Muted>
      <ErrorText>{error}</ErrorText>

      <View style={s.filters}>
        {networks.map((n) => (
          <TouchableOpacity
            key={n}
            style={[s.filter, network === n && s.filterActive]}
            onPress={() => setNetwork(n)}
          >
            <Text style={[s.filterText, network === n && { color: colors.primaryForeground }]}>{n}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(p) => p.id}
        numColumns={2}
        columnWrapperStyle={{ gap: 10 }}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.pkg} onPress={() => setSelected(item)}>
            <View style={[s.netDot, { backgroundColor: networkColors[item.network] ?? colors.primary }]} />
            <Text style={s.pkgSize}>{item.size}</Text>
            <Muted>{item.network}</Muted>
            <Text style={s.pkgPrice}>GHS {Number(item.price).toFixed(2)}</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Card><Muted>No packages available.</Muted></Card>}
      />

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={s.modalWrap}>
          <Card style={s.modal}>
            <Text style={s.modalTitle}>
              {selected?.network} {selected?.size} — GHS {Number(selected?.price ?? 0).toFixed(2)}
            </Text>
            <Field
              label="Recipient phone number"
              placeholder="0241234567"
              keyboardType="phone-pad"
              value={phone}
              onChangeText={setPhone}
            />
            <Button label="Pay from Wallet" onPress={buy} busy={busy} />
            <Button label="Cancel" variant="ghost" onPress={() => setSelected(null)} />
          </Card>
        </View>
      </Modal>
    </Screen>
  )
}

const s = StyleSheet.create({
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 12 },
  filter: {
    borderColor: colors.border, borderWidth: 1, borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 6, backgroundColor: colors.card,
  },
  filterActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  pkg: {
    flex: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.lg, padding: 14, marginBottom: 10, gap: 2, ...cardShadow,
  },
  netDot: { width: 10, height: 10, borderRadius: 5, marginBottom: 6 },
  pkgSize: { color: colors.text, fontSize: 18, fontWeight: "800" },
  pkgPrice: { color: colors.primary, fontWeight: "700", marginTop: 4 },
  modalWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15,23,42,0.45)" },
  modal: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, paddingBottom: 32 },
  modalTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginBottom: 12 },
})
