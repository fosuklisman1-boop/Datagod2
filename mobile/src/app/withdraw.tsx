import { useEffect, useState } from "react"
import {
  ScrollView, Text, View, TouchableOpacity, StyleSheet, Alert, Modal, FlatList,
} from "react-native"
import { useRouter } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { Screen, Card, Button, Field, Muted } from "@/components/ui"
import {
  getMyShop, getShopAvailableBalance, getBanks, validateWithdrawalAccount,
  getWithdrawalFeePercentage, createWithdrawal, type MyShop, type MoolreBank,
} from "@/lib/datagod"
import { normalizeGhanaPhone, isValidGhanaMobile } from "@/lib/phone-format"
import { colors, radius } from "@/lib/theme"

// Validate-account expects MTN / Telecel / AT (the web sends the same values).
const MOMO_NETWORKS = ["MTN", "Telecel", "AT"]

export default function WithdrawScreen() {
  const router = useRouter()
  const [shop, setShop] = useState<MyShop | null | undefined>(undefined) // undefined = loading
  const [balance, setBalance] = useState(0)
  const [feePct, setFeePct] = useState(0)

  const [method, setMethod] = useState<"mobile_money" | "bank_transfer">("mobile_money")
  const [network, setNetwork] = useState("MTN")
  const [phone, setPhone] = useState("")
  const [banks, setBanks] = useState<MoolreBank[]>([])
  const [bank, setBank] = useState<MoolreBank | null>(null)
  const [bankPickerOpen, setBankPickerOpen] = useState(false)
  const [accountNumber, setAccountNumber] = useState("")
  const [accountName, setAccountName] = useState("")
  const [verified, setVerified] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    ;(async () => {
      const myShop = await getMyShop().catch(() => null)
      setShop(myShop)
      if (myShop) {
        getShopAvailableBalance(myShop.id).then(setBalance).catch(() => {})
        getWithdrawalFeePercentage()
          .then((f) => setFeePct(f.withdrawal_fee_percentage || 0))
          .catch(() => {})
      }
    })()
  }, [])

  // Bank list is only needed (and fetched) when the bank method is selected.
  useEffect(() => {
    if (method === "bank_transfer" && banks.length === 0) {
      getBanks().then(setBanks).catch(() => {})
    }
  }, [method, banks.length])

  // Any change to the destination account invalidates a previous verification.
  const resetVerification = () => {
    setVerified(false)
    setAccountName("")
  }

  const verify = async () => {
    setVerifying(true)
    try {
      if (method === "mobile_money") {
        const normalized = normalizeGhanaPhone(phone)
        if (!normalized || !isValidGhanaMobile(phone)) {
          Alert.alert("Invalid number", "Enter a valid Ghana mobile number")
          return
        }
        const res = await validateWithdrawalAccount({ phone: normalized, network })
        setAccountName(res.accountName)
        setVerified(true)
      } else {
        if (!bank || !accountNumber.trim()) {
          Alert.alert("Missing details", "Select a bank and enter the account number")
          return
        }
        const res = await validateWithdrawalAccount({
          network: "BANK",
          accountNumber: accountNumber.trim(),
          sublistid: bank.sublistid,
        })
        setAccountName(res.accountName)
        setVerified(true)
      }
    } catch (e: any) {
      Alert.alert("Verification failed", e?.message ?? "Could not verify the account")
    } finally {
      setVerifying(false)
    }
  }

  const amt = parseFloat(amount) || 0
  const fee = Math.round(amt * (feePct / 100) * 100) / 100
  const net = Math.max(0, amt - fee)
  const canSubmit = verified && amt >= 5 && amt <= balance

  const submit = async () => {
    if (!shop) return
    setBusy(true)
    try {
      const account_details: Record<string, string> =
        method === "mobile_money"
          ? { phone: normalizeGhanaPhone(phone) ?? phone, account_name: accountName, network }
          : {
              bank_name: bank?.name ?? "",
              sublistid: bank?.sublistid ?? "",
              account_number: accountNumber.trim(),
              account_name: accountName,
            }
      await createWithdrawal({ shopId: shop.id, amount: amt, withdrawal_method: method, account_details })
      Alert.alert(
        "Request submitted",
        `GHS ${amt.toFixed(2)} withdrawal requested. You'll receive GHS ${net.toFixed(2)} after the ${feePct}% fee once an admin approves it.`,
        [{ text: "OK", onPress: () => router.replace("/withdrawals") }],
      )
    } catch (e: any) {
      Alert.alert("Withdrawal failed", e?.message ?? "Please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="Withdraw" back>
      {shop === undefined ? (
        <Card><Muted>Loading…</Muted></Card>
      ) : shop === null ? (
        <Card>
          <Muted>
            Withdrawals are for shop owners. Create your shop on the web dashboard first.
          </Muted>
          <Button label="Go Back" variant="ghost" onPress={() => router.back()} />
        </Card>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Card>
            <Muted>Available shop balance</Muted>
            <Text style={s.balance}>GHS {balance.toFixed(2)}</Text>
          </Card>

          {/* Method */}
          <View style={s.segmentRow}>
            {([["mobile_money", "Mobile Money"], ["bank_transfer", "Bank"]] as const).map(([key, label]) => (
              <TouchableOpacity
                key={key}
                style={[s.segment, method === key && s.segmentActive]}
                onPress={() => {
                  setMethod(key)
                  resetVerification()
                }}
              >
                <Text style={[s.segmentText, method === key && s.segmentTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Card>
            {method === "mobile_money" ? (
              <>
                <View style={s.netRow}>
                  {MOMO_NETWORKS.map((n) => (
                    <TouchableOpacity
                      key={n}
                      style={[s.net, network === n && s.netActive]}
                      onPress={() => {
                        setNetwork(n)
                        resetVerification()
                      }}
                    >
                      <Text style={[s.netText, network === n && s.netTextActive]}>{n}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Field
                  label="MoMo phone number"
                  placeholder="0241234567"
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={(v) => {
                    setPhone(v)
                    resetVerification()
                  }}
                />
              </>
            ) : (
              <>
                <Text style={s.label}>Bank</Text>
                <TouchableOpacity style={s.bankSelect} onPress={() => setBankPickerOpen(true)}>
                  <Text style={bank ? s.bankSelectText : s.bankSelectPlaceholder}>
                    {bank ? bank.name : "Select your bank"}
                  </Text>
                </TouchableOpacity>
                <Field
                  label="Account number"
                  placeholder="0011223344556"
                  keyboardType="number-pad"
                  value={accountNumber}
                  onChangeText={(v) => {
                    setAccountNumber(v)
                    resetVerification()
                  }}
                />
              </>
            )}

            {verified && accountName ? (
              <View style={s.verifiedBox}>
                <View style={s.verifiedRow}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                  <Text style={s.verifiedName}>{accountName}</Text>
                </View>
                <Muted>Account name verified</Muted>
              </View>
            ) : (
              <Button label="Verify Account" variant="secondary" onPress={verify} busy={verifying} />
            )}
          </Card>

          <Card>
            <Field
              label={`Amount (GHS) — min 5.00, max ${balance.toFixed(2)}`}
              placeholder="50"
              keyboardType="decimal-pad"
              value={amount}
              onChangeText={setAmount}
            />
            {amt > 0 && (
              <View style={s.feeRow}>
                <Muted>Fee ({feePct}%): GHS {fee.toFixed(2)}</Muted>
                <Text style={s.netAmount}>You receive: GHS {net.toFixed(2)}</Text>
              </View>
            )}
            <Button label="Request Withdrawal" onPress={submit} busy={busy} disabled={!canSubmit} />
            {!verified && <Muted>Verify the destination account to continue.</Muted>}
          </Card>
        </ScrollView>
      )}

      {/* Bank picker — content unchanged below */}
      <Modal visible={bankPickerOpen} transparent animationType="slide" onRequestClose={() => setBankPickerOpen(false)}>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Select bank</Text>
            <FlatList
              data={banks}
              keyExtractor={(b) => b.sublistid}
              style={{ maxHeight: 420 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={s.bankRow}
                  onPress={() => {
                    setBank(item)
                    resetVerification()
                    setBankPickerOpen(false)
                  }}
                >
                  <Text style={s.bankRowText}>{item.name}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Muted>Loading banks…</Muted>}
            />
            <Button label="Cancel" variant="ghost" onPress={() => setBankPickerOpen(false)} />
          </View>
        </View>
      </Modal>
    </Screen>
  )
}

const s = StyleSheet.create({
  balance: { color: colors.text, fontSize: 28, fontWeight: "800", marginTop: 4 },
  segmentRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  segment: {
    flex: 1, alignItems: "center", paddingVertical: 10,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card,
  },
  segmentActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  segmentText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  segmentTextActive: { color: colors.primaryForeground },
  netRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  net: {
    flex: 1, alignItems: "center", paddingVertical: 10,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  netActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  netText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  netTextActive: { color: colors.primaryForeground },
  label: { color: colors.textMuted, fontSize: 13, marginBottom: 6 },
  bankSelect: {
    backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.md, padding: 12, marginBottom: 12,
  },
  bankSelectText: { color: colors.text, fontSize: 15 },
  bankSelectPlaceholder: { color: colors.textMuted, fontSize: 15 },
  verifiedBox: {
    backgroundColor: `${colors.success}1A`, borderRadius: radius.md,
    padding: 12, marginTop: 4,
  },
  verifiedRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 },
  verifiedName: { color: colors.success, fontWeight: "700" },
  feeRow: { marginBottom: 10, gap: 2 },
  netAmount: { color: colors.text, fontWeight: "700", fontSize: 14 },
  modalWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15,23,42,0.45)" },
  modal: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: 16, paddingBottom: 32,
  },
  modalTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginBottom: 12 },
  bankRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  bankRowText: { color: colors.text, fontSize: 15 },
})
