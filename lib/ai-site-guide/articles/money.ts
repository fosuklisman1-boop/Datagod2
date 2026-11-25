import type { SiteArticle } from "../types"

/**
 * How-to articles about money: wallet top-up, paying from the wallet, Send & Claim, withdrawals, refunds, cashback,
 * dealer upgrades and transaction history. Written from the real pages: app/dashboard/wallet, components/wallet-top-up.tsx,
 * components/wallet/send-and-claim/*, app/dashboard/shop-withdraw, app/dashboard/upgrade, app/dashboard/transactions,
 * lib/refunds/notify.ts and lib/cashback/display.ts. Prices, fees, minimums, limits and waits are configurable, so the
 * articles say "shown on the page" and contain no digits at all.
 */
export const MONEY_ARTICLES: SiteArticle[] = [
  {
    id: "wallet-top-up",
    title: "Add money to your wallet (top up)",
    audiences: ["customer"],
    keywords: ["top up", "topup", "add money", "fund wallet", "load wallet", "wallet", "momo", "mobile money", "paystack", "hubtel", "card", "balance", "deposit", "pay into wallet"],
    summary: "Top up your wallet from the Wallet page with Mobile Money or card. Top-up may be paused for some accounts. Steps, the fee note and what you see afterwards.",
    body: `What it is: adding money to your Datagod wallet so you can buy data, airtime and more without paying each time.

Who can use it: logged-in customers and dealers. Top-up may not be available on your account right now. When customer top-ups are paused the page says "Top-ups are paused", and dealers can still top up.

Where: Wallet (/dashboard/wallet), on the Top Up Wallet section.

How:
1. Open Wallet and check your balance at the top.
2. Type the amount in "Amount (GHS)", or tap one of the quick amounts. The smallest amount allowed is shown under the box.
3. Read the Payment Summary. It shows the top-up, the payment fee (if any) and the total. The fee is set by the payment partner, so check the total before you pay.
4. If the page asks for a Mobile Money number, type the number you will pay from. You may be asked to tap Send verification code and type the code from the SMS. This is done once per number.
5. Tap the pay button. Depending on how it is set up, you either get a Mobile Money prompt on your phone (approve it with your PIN; Telecel Cash may ask for a one-time code) or you are sent to the secure payment page of Paystack to pay.

What happens next: when the payment is confirmed you see "Top-Up Successful!" and your balance goes up. The entry shows under Recent transactions on the same page and on Transactions (/dashboard/transactions).

If something goes wrong:
- Money taken but balance not updated: see the article on a top-up that is not credited.
- No prompt on your phone: check the number and your network, then try again.
- If top-up is paused, wait and check back, or use Send and Claim if your Wallet page shows that tab.`,
  },
  {
    id: "wallet-top-up-not-credited",
    title: "I paid to top up but my wallet is not credited",
    audiences: ["customer"],
    keywords: ["not credited", "wallet not updated", "paid but no money", "money no show", "pending payment", "verify payment", "payment pending", "abandoned", "top up failed", "balance not changed", "wallet empty", "momo deducted"],
    summary: "If you paid a top-up and the balance did not change, use Verify Payment on the Pending Payments box on the Wallet page. Wait a few minutes first, then contact support with your reference.",
    body: `What it is: what to do when a top-up payment left your Mobile Money or card but the wallet balance did not go up.

Who can use it: logged-in customers and dealers.

Where: Wallet (/dashboard/wallet), then Support chat (/dashboard/complaints) if needed.

How:
1. Do not pay again yet. Wait a few minutes and refresh the Wallet page.
2. Look for a box called Pending Payments near the top. It lists top-ups from the last day that are still pending or were abandoned, with the amount, the time and the end of the reference.
3. Tap Verify Payment next to the one you paid. The page re-checks it with the payment partner.
4. Read the message. "Payment verified" means your wallet was credited. "Still processing" means try again in a few minutes. "Not completed" means the payment did not go through.
5. Still nothing? Open Support chat (/dashboard/complaints), start a chat and give the amount, the time, the number you paid from and the reference shown on the Pending Payments box or in your payment message.

What happens next: a verified payment credits the wallet and adds an entry to Transactions (/dashboard/transactions). If you approved the prompt late, the wallet can still be credited after the page said it timed out.

If something goes wrong: a payment that was not completed means no money should have left your account. If money did leave and the wallet is still not credited after verifying, support checks it from the chat. Keep your payment message or screenshot.`,
  },
  {
    id: "pay-from-wallet",
    title: "Paying for things from your wallet",
    audiences: ["customer"],
    keywords: ["pay from wallet", "wallet payment", "wallet balance", "insufficient balance", "not enough", "buy data wallet", "airtime wallet", "balance", "deducted", "spend", "wallet pay"],
    summary: "Data packages, Standard bundles, airtime, utility bills, results checkers and AFA registration are paid from your wallet balance. If it is too low, top up first.",
    body: `What it is: when you are logged in, most purchases take the money straight from your wallet balance. There is no payment prompt for each order.

Who can use it: logged-in customers and dealers.

Where: Data packages (/dashboard/data-packages), Standard bundles (/dashboard/standard-bundles), Buy airtime (/dashboard/airtime), Utility bills (/dashboard/bills), Results checker (/dashboard/results-checker) and AFA orders (/dashboard/afa-orders). Your balance and top-up are on Wallet (/dashboard/wallet).

How:
1. Check your balance on Wallet or at the top of the page you are buying on.
2. Pick what you want and enter the number or details.
3. Check the price on the confirm screen. Prices and any fee are shown there, so the page is the final word.
4. Confirm. The amount is taken from your wallet.
5. If the page says "Insufficient balance", or the buy button shows "Insufficient Balance", top up first on Wallet and come back.

What happens next: you see a success message, and the order appears on My orders (/dashboard/my-orders) while the money shows as a debit on Transactions (/dashboard/transactions).

If something goes wrong:
- An order failed after the money was taken: see the article on refunds and where to see them.
- A purchase page says it is paused: try again later.
- The balance looks wrong: open Transactions and compare the entries, then use Support chat (/dashboard/complaints) with the entry you are asking about.`,
  },
  {
    id: "send-and-claim",
    title: "Send and Claim: fund your wallet by sending Mobile Money",
    audiences: ["customer"],
    keywords: ["send and claim", "send & claim", "momo transfer", "send money", "reference code", "payment details", "transaction id", "fund wallet", "wallet", "top up", "not credited", "claim", "send mobile money"],
    summary: "Send and Claim funds your wallet by sending Mobile Money to our number with a reference code. It may not be available on your account yet. Steps and what to do if it is not credited.",
    body: `What it is: another way to fund your wallet. You send Mobile Money to a number we show you, with a reference code, and the wallet is credited.

Who can use it: logged-in customers and dealers who have a verified phone number. It may not be available on your account yet. If it is switched on you see two tabs on the Wallet page: "Top Up Wallet" and "Send & Claim". If you see no tabs, it is not on.

Where: Wallet (/dashboard/wallet), on the Send & Claim tab.

How:
1. Open the Send & Claim tab. The box called "How Send & Claim works" explains the steps.
2. Type the amount in "Amount (GHS)". The page shows the fee, if any, and what you get. The smallest and largest amounts are shown on the page. Some payments are checked before the money appears, and the page shows the status.
3. Tap Generate Payment Details.
4. You see a Mobile Money number and a short reference code. Open your MoMo menu or app and choose Send Money.
5. Send the exact amount to that number and type the reference code in the reference or narration box. Approve with your PIN.

What happens next: your wallet is credited automatically within moments and you see it on the Wallet page. Your payment details are valid for a short time, with a countdown. If time runs out, generate new details. You can only have a limited number of open payments at once; the page says when a new one unlocks.

If something goes wrong:
- Sent money but not credited: use the "Sent money but not credited?" box on the same tab. Pick the payment and type the transaction ID from your MoMo confirmation SMS.
- "Verify your phone number": confirm your number on Profile (/dashboard/profile) first.
- Still not credited: open Support chat (/dashboard/complaints) with the transaction ID and time.`,
  },
  {
    id: "withdraw-shop-profit",
    title: "Withdraw your shop profit to MoMo or bank",
    audiences: ["shop_owner"],
    keywords: ["withdraw", "withdrawal", "cash out", "payout", "shop profit", "earnings", "momo", "bank", "bank transfer", "pending withdrawal", "profit", "account name", "verify account"],
    summary: "Shop owners and sub-agents can withdraw shop profit to Mobile Money or a bank account from the Withdraw profit page. Steps, what the statuses mean and what to do if it is stuck.",
    body: `What it is: sending the profit your shop earned to your own Mobile Money number or bank account.

Who can use it: shop owners and sub-agents. You need a shop. The Wallet page has no withdraw option: the money you top up there cannot be withdrawn here. This page pays out shop profit only.

Where: Withdraw profit (/dashboard/shop-withdraw). Your profit history is on Profit logs (/dashboard/shop-profit-logs).

How:
1. Open Withdraw profit and check Available Balance, the amount earned and the amount already withdrawn.
2. Type the amount. The smallest amount is shown on the page. The Payout Breakdown shows the processing fee and "You Receive". Fee and minimum are set by the platform, so read them on the page.
3. Choose Mobile Money or Bank Transfer.
4. For Mobile Money pick the network (MTN, Telecel or AT) and type the number. For bank, pick the bank and type the account number.
5. Tap Verify. The account holder name is checked and shown. If checking keeps failing you can tap Verify Manually and type the name, but then the team reviews it before paying.
6. Tap Submit Withdrawal Request.

What happens next: the request shows in Withdrawal History as pending. It then moves through processing to completed, or ends as rejected or failed. Payouts are processed on business days, so weekends and holidays wait. Only one request can be open at a time. If you can't withdraw yet, the page tells you when you can try again.

If something goes wrong:
- "Insufficient balance" or an amount below the minimum: change the amount.
- The name will not verify: check the number, network or bank, then use Verify Manually.
- Rejected or failed, or pending for long: open Support chat (/dashboard/complaints) with the date and amount.`,
  },
  {
    id: "refunds-where-to-see-them",
    title: "Refunds: how they work and where you see them",
    audiences: ["customer"],
    keywords: ["refund", "refunded", "money back", "returned", "wallet credited", "failed order money", "get my money", "chargeback", "reversal", "refund sms", "notification", "credit", "payment returned"],
    summary: "Refunds are made by the Datagod team, not automatically. A refunded wallet order shows as a credit on Transactions, in your notifications and sometimes by SMS. Ask in Support chat if it is missing.",
    body: `What it is: how a refund works and where you can see that it happened.

Who can use it: logged-in customers and dealers. Guests who paid on a shop page should contact that shop.

Where: Transactions (/dashboard/transactions), Wallet (/dashboard/wallet), Notifications (/dashboard/notifications), My orders (/dashboard/my-orders) and Support chat (/dashboard/complaints).

How:
1. Open My orders and check the order. A refund is only for an order that could not be completed, such as one that failed.
2. Open Transactions. A refund shows as its own credit entry (a plus amount). Tabs split entries by type, so also look in the Data, Airtime, AFA, Results Checker or Misc tab, or Top Ups.
3. Check Notifications. A wallet refund adds a notice called "Order refunded".
4. Look at your phone for an SMS saying the order could not be completed and the amount was refunded.
5. If you see nothing, open Support chat (/dashboard/complaints) and give the order details. Write the number, the time and the amount.

What happens next: the Datagod team checks the order and decides. Refunds are made by the support team, and they appear as described above. An order that was delivered cannot be refunded. An order that is still being sent may need to wait until it either arrives or fails.

If something goes wrong: do not assume a refund is automatic or instant. Wallet refunds show on the Wallet page and Transactions once made. For a complaint about a delivered order, see the article on data that has not arrived.`,
  },
  {
    id: "cashback-instant-discount",
    title: "Cashback: a lower price at checkout",
    audiences: ["customer"],
    keywords: ["cashback", "cash back", "discount", "lower price", "was price", "you pay", "you receive", "airtime cashback", "bills cashback", "standard bundles cashback", "reward", "save"],
    summary: "Cashback on Datagod shows up as a lower price at checkout (You pay versus was). It may not apply to every service or account. The checkout page shows the exact amount.",
    body: `What it is: on some services the price you pay is lower than the normal price. The page shows it as a "was" price and a lower "You pay" amount. It is a discount applied when you buy, not a separate amount sent to you later.

Who can use it: logged-in customers and dealers. It may not apply to every service, network or account, and it can change. If you see no "was" price, there is no cashback on that purchase.

Where: Buy airtime (/dashboard/airtime), Standard bundles (/dashboard/standard-bundles) and Utility bills (/dashboard/bills).

How:
1. Open the service and pick the network or bundle.
2. Enter the number and the amount.
3. Look at the summary on the buy screen. It has "You pay", "You receive" and your wallet balance. When a discount applies the bundle card also shows the old price as "was".
4. Check that your wallet covers "You pay". If it does not, the page shows the shortfall, so top up first on Wallet (/dashboard/wallet).
5. Confirm the purchase.

What happens next: the lower amount is taken from your wallet and you see it on Transactions (/dashboard/transactions). If the price changed while you were on the page, the page shows a message with the new amount, and you can check it before you confirm again.

If something goes wrong: if the amount taken does not match what you saw, open Support chat (/dashboard/complaints) with the order and the amount on the Transactions entry. The checkout page is the final word on price, so the assistant cannot quote one.`,
  },
  {
    id: "dealer-upgrade-subscription",
    title: "Become a dealer: plans, payment and renewing",
    audiences: ["customer"],
    keywords: ["upgrade", "dealer", "become dealer", "subscription", "plan", "renew", "extend", "expires", "wholesale", "price list", "dealer club", "membership", "dealer plan"],
    summary: "Upgrade to a dealer on the Upgrade to dealer page: pick a plan, pay, and get wholesale prices. Plans and prices come from the page. Dealers can renew before it expires.",
    body: `What it is: a paid dealer plan that gives wholesale prices and dealer tools, such as shops and sub-agents. Each plan lasts for a set time, shown on the plan card.

Who can use it: logged-in customers. Dealers can also renew. Upgrades can be paused. When they are, the page says "Upgrades temporarily disabled" and the button reads "Currently Unavailable".

Where: Upgrade to dealer (/dashboard/upgrade).

How:
1. Open Upgrade to dealer. Each plan card shows its name, how long it lasts and the price. Prices are on the page, so the assistant does not quote them.
2. Tap View Price List to see the dealer prices by network before you decide.
3. Tap Upgrade Now on the plan you want. Active dealers see Renew / Extend instead.
4. If asked, type the Mobile Money number you will pay from, and verify it with the code sent by SMS.
5. Pay. You either approve a prompt on your phone or go to the secure payment page of Paystack or Hubtel, whichever the page names. This is paid through that payment page and not from your wallet.

What happens next: when the payment is confirmed you see a congratulations message and the dealer benefits start straight away. Active dealers see how many days are left and an EXPIRES SOON tag near the end. When the plan ends, dealer prices stop until you renew.

If something goes wrong:
- Paid but not upgraded: wait a minute, refresh, then open Support chat (/dashboard/complaints) with your payment reference.
- "New dealer plans coming soon": no plan is open right now, so try later.
- Payment not completed: nothing was upgraded. Try again.`,
  },
  {
    id: "transaction-history",
    title: "See your transaction history",
    audiences: ["customer"],
    keywords: ["transactions", "history", "statement", "payments", "debit", "credit", "where did my money go", "spent", "top ups", "records", "wallet history", "receipt", "past payments"],
    summary: "The Transactions page lists every wallet credit and debit in tabs: Stats, Top Ups, Data, Results Checker, Airtime, AFA and Misc. Wallet shows the latest few.",
    body: `What it is: the list of every payment and wallet movement on your account, such as top-ups, purchases and refunds.

Who can use it: logged-in customers and dealers.

Where: Transactions (/dashboard/transactions). The Wallet page (/dashboard/wallet) also lists your most recent transactions under "Recent transactions".

How:
1. Open Transactions. The first tab, Stats, shows your total number of transactions, today's income and today's expenses.
2. Pick a tab for what you want: Top Ups, Data, Results Checker, Airtime, AFA or Misc. Anything that does not fit another tab is in Misc.
3. Each row shows the description, the date, the end of the reference, and the amount. A plus sign in green is money in. A minus sign in red is money out. A row marked Pending is still waiting.
4. Use the reference and date to match a row to an order on My orders (/dashboard/my-orders).

What happens next: new payments appear after they are confirmed. A top-up that is still pending shows on Wallet in the Pending Payments box.

If something goes wrong:
- A top-up you made is missing: see the article on a top-up that is not credited.
- An entry you do not recognise or an amount that looks wrong: open Support chat (/dashboard/complaints) and give the date, the amount and the reference.`,
  },
]
