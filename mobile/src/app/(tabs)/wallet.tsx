import { useCallback, useState } from "react"
import { FlatList, Text, View, StyleSheet, Alert, RefreshControl } from "react-native"
import * as WebBrowser from "expo-web-browser"
import { useFocusEffect, useRouter } from "expo-router"
import { Screen, Card, Button, Field, Muted } from "@/components/ui"
import {
  getWalletBalance, getTransactions, initializeTopup, verifyPayment,
  getMyShop, getShopAvailableBalance,
  type WalletTransaction, type MyShop,
} from "@/lib/datagod"
import { supabase } from "@/lib/supabase"
import { colors } from "@/lib/theme"

export default function WalletScreen() {
  const router = useRouter()
  const [balance, setBalance] = useState(0)
  const [txns, setTxns] = useState<WalletTransaction[]>([])
  const [shop, setShop] = useState<MyShop | null>(null)
  const [shopBalance, setShopBalance] = useState(0)
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const [w, t, myShop] = await Promise.all([
        getWalletBalance(),
        getTransactions(1, 20),
        getMyShop().catch(() => null),
      ])
      setBalance(w.balance)
      setTxns(t)
      setShop(myShop)
      if (myShop) {
        getShopAvailableBalance(myShop.id).then(setShopBalance).catch(() => {})
      }
    } catch {
      // pull-to-refresh retries
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  const topUp = async () => {
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) {
      Alert.alert("Invalid amount", "Enter the amount to top up in GHS")
      return
    }
    setBusy(true)
    try {
      const { data: auth } = await supabase.auth.getUser()
      const email = auth.user?.email
      const userId = auth.user?.id
      if (!email || !userId) throw new Error("Session expired — please sign in again")

      // Hosted Paystack checkout in an in-app browser; webhook + verify credit
      // the wallet exactly as on the web.
      const init = await initializeTopup(amt, email, userId)
      await WebBrowser.openBrowserAsync(init.authorizationUrl)

      // After the user returns, verify the reference and refresh.
      try {
        await verifyPayment(init.reference)
      } catch {
        // Verification also runs server-side via webhook/cron; ignore here.
      }
      setAmount("")
      await load()
    } catch (e: any) {
      Alert.alert("Top-up failed", e?.message ?? "Please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="Wallet">
      <FlatList
        data={txns}
        keyExtractor={(t) => t.id}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true)
              await load()
              setRefreshing(false)
            }}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <>
            <Card>
              <Muted>Balance</Muted>
              <Text style={s.balance}>GHS {balance.toFixed(2)}</Text>
              <Field
                label="Top up amount (GHS)"
                placeholder="50"
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={setAmount}
              />
              <Button label="Top Up Wallet" variant="success" icon="add" onPress={topUp} busy={busy} />
            </Card>

            {shop && (
              <Card>
                <Muted>Shop earnings{shop.shop_name ? ` — ${shop.shop_name}` : ""}</Muted>
                <Text style={s.balance}>GHS {shopBalance.toFixed(2)}</Text>
                <Button label="Withdraw" onPress={() => router.push("/withdraw")} />
                <Button label="Withdrawal History" variant="ghost" onPress={() => router.push("/withdrawals")} />
              </Card>
            )}

            <Text style={s.section}>Transactions</Text>
          </>
        }
        renderItem={({ item }) => (
          <Card style={s.txn}>
            <View style={{ flex: 1 }}>
              <Text style={s.txnDesc} numberOfLines={1}>
                {item.description || item.source || item.type}
              </Text>
              <Muted>{new Date(item.created_at).toLocaleString()}</Muted>
            </View>
            <Text style={[s.txnAmt, { color: item.type === "credit" ? colors.success : colors.danger }]}>
              {item.type === "credit" ? "+" : "-"}GHS {Number(item.amount).toFixed(2)}
            </Text>
          </Card>
        )}
        ListEmptyComponent={<Card><Muted>No transactions yet.</Muted></Card>}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </Screen>
  )
}

const s = StyleSheet.create({
  balance: { color: colors.text, fontSize: 32, fontWeight: "800", marginVertical: 6 },
  section: { color: colors.text, fontSize: 16, fontWeight: "700", marginVertical: 10 },
  txn: { flexDirection: "row", alignItems: "center" },
  txnDesc: { color: colors.text, fontWeight: "600", marginBottom: 2 },
  txnAmt: { fontWeight: "800", marginLeft: 10 },
})
