import { COMPLETED_WAIT_MS, PROCESSING_WAIT_MS } from "../../support-eligibility"
import type { SiteArticle } from "../types"

const COMPLETED_MINUTES = COMPLETED_WAIT_MS / 60000
const PROCESSING_HOURS = PROCESSING_WAIT_MS / 3600000

/**
 * How-to articles for buying data, following an order, and AFA registration.
 * Written from the real pages: app/dashboard/data-packages, standard-bundles, my-orders, afa-orders,
 * app/shop/[slug] (storefront, order-status, afa). Prices, fees, limits and delivery times are never quoted: they
 * are configurable, so the articles say "shown on the page". The only numbers allowed are the complaint waits,
 * which come from lib/support-eligibility.ts (COMPLETED_WAIT_MS, PROCESSING_WAIT_MS).
 */
export const BUYING_ARTICLES: SiteArticle[] = [
  {
    id: "buy-data-dashboard",
    title: "Buy data from your wallet (Data packages)",
    audiences: ["customer"],
    keywords: ["buy data", "data packages", "wallet", "bundle", "mtn", "telecel", "at ishare", "bigtime", "bulk order", "single order", "dashboard", "purchase"],
    summary: "Buy a data bundle for any number from the Data packages page, paid from your wallet. Covers single orders, bulk orders and the MTN number check.",
    body: `What it is: the quickest way to buy a data bundle when you are logged in. The amount comes out of your wallet.

Who can use it: any logged-in customer or dealer. Dealers see their own prices.

Where: Data packages (/dashboard/data-packages). Your wallet is at Wallet (/dashboard/wallet).

How:
1. Open Data packages and tap the network: MTN, Telecel, AT iShare or AT BigTime.
2. Find the bundle (use the search box if the list is long) and tap it.
3. Type the number that should receive the data. It can be your number or somebody else's.
4. Check the package and price on the confirm screen, then confirm.
5. Many bundles at once: switch from Single to Bulk Order, add one number and size per line (or upload a file), check the preview, then submit.

Good to know:
- The page has a switch for the order SMS confirmation, which texts the beneficiary.
- For MTN there is a "Check MTN Number Registration" tool. Paste numbers to see which are registered.
- If a number is not yet verified you see a warning. You can change the number or go ahead; delivery may be delayed until the number clears. Some numbers cannot be ordered at all, and then you must use a different one.
- The number must belong to the network you picked.

What happens next: the price is taken from your wallet, you see "Purchase successful", and the order appears in My orders (/dashboard/my-orders) with a status that updates as it is delivered.

If something goes wrong:
- "Insufficient balance": top up on the Wallet page when top-up is available on your account.
- Maintenance message: buying is paused for now, so try again later.
- Order stuck or failed: see the articles on order statuses and on failed orders, or open Support chat (/dashboard/complaints).`,
  },
  {
    id: "buy-data-shop-storefront",
    title: "Buy data from a shop without an account",
    audiences: ["public"],
    keywords: ["buy data", "shop", "storefront", "guest", "no account", "without account", "momo", "mobile money", "pay", "checkout", "agent shop", "data bundle"],
    summary: "Anyone can buy data from a Datagod shop page with Mobile Money. No account needed. Pick a bundle, enter the number, pay and approve the prompt on your phone.",
    body: `What it is: every shop has its own page where customers buy data, airtime and more. You do not need to sign up.

Who can use it: anyone with a Mobile Money wallet or card.

Where: the shop's own page, Shop storefront (/shop/:slug). The shop owner shares the link.

How:
1. Open the shop link and choose Data Packages.
2. Pick the network, then the bundle you want. The price shown is the shop's price.
3. In the checkout sheet, type the phone number that will receive the data.
4. Enter the Mobile Money number you will pay from, or tick the box to use the same number. Choose how you pay: MTN MoMo, Telecel Cash or AT Money.
5. If asked, tap Send verification code and type the code from the SMS to prove the payment number is yours.
6. Add your name. Email is optional and is only used for a receipt.
7. Check the total, which can include a small payment fee, then tap to pay.

What happens next: with MoMo, a prompt arrives on your phone. Approve it with your PIN. Telecel Cash may instead send a one-time code that you type into the sheet. Some shops send you to a secure payment page instead. Once payment is confirmed you see a success message, and the data is delivered to the number you entered. Use Track My Orders on the shop page to follow it.

If something goes wrong: see the article on shop payment problems. For a delivery problem use the shop's contact details under About Shop & Terms or its WhatsApp button, if it has one.`,
  },
  {
    id: "buy-data-for-someone-else",
    title: "Buy data for a friend or family member",
    audiences: ["public"],
    keywords: ["friend", "family", "someone else", "another number", "other person", "for my brother", "gift data", "send data", "buy data for", "recipient", "beneficiary", "different number", "abeg"],
    summary: "You can buy a bundle for any number, not just your own. The number that pays and the number that receives data can be different.",
    body: `What it is: when you order data you choose who receives it. It can be you, a friend, a customer or a relative.

Who can use it: anyone, with or without an account.

Where: a shop page, Shop storefront (/shop/:slug), or the Data packages page when you are logged in.

How:
1. Choose the network your friend uses. Their number must be on that network.
2. Pick the bundle.
3. When asked for the phone number, type your friend's number, not yours. Check every digit.
4. Pay. On a shop page the Mobile Money number you pay from can be yours while the data number is your friend's.
5. Ask your friend to watch for the SMS or data balance.

What happens next: the data goes to the number you typed. It cannot be redirected after you pay, so a wrong digit means the wrong person gets it.

If something goes wrong:
- The site rejects the number: it probably belongs to a different network or has a mistake. See the article on networks and numbers.
- Wrong number typed: contact support from the Support chat if you are logged in, or the shop, straight away with the order details.`,
  },
  {
    id: "data-networks-and-numbers",
    title: "Networks and phone numbers for data orders",
    audiences: ["public"],
    keywords: ["network", "mtn", "telecel", "vodafone", "airteltigo", "at", "ishare", "bigtime", "prefix", "wrong network", "number rejected", "invalid number", "activating number", "not registered", "held", "number rejected"],
    summary: "Which networks you can buy, why a number is rejected, and what 'Activating number' and unverified MTN numbers mean.",
    body: `What it is: how phone numbers are checked when you order data.

Who can use it: everyone.

Where: shop pages, Shop storefront (/shop/:slug), and the Data packages page when you are logged in.

How:
1. Choose the network: MTN, Telecel, AT iShare or AT BigTime. Only networks shown on the page can be bought.
2. Type the number with ten digits, as on the SIM.
3. The page checks that the number's prefix matches the network. A number from a different network is rejected, so pick the right network first.
4. For MTN numbers the page may also check whether the number is ready to receive data.

What happens next:
- "Ready to receive" means you can go ahead.
- "Not yet confirmed" means you can still order, but delivery may be delayed until MTN clears the number. On the orders page this shows as "Activating number". The data is delivered by itself once the number is active, which is usually within a day.
- Some MTN numbers cannot be ordered at all and the page asks you to use a different number.

If something goes wrong:
- Number rejected: check the network and every digit.
- Still "Activating number" after a day: contact the Support chat if you are logged in, or the shop if you bought from one.`,
  },
  {
    id: "standard-bundles",
    title: "Standard bundles",
    audiences: ["customer"],
    keywords: ["standard bundles", "standard bundle", "airteltigo", "telecel broadband", "mtn", "wallet", "bundles", "cashback", "catalog", "sheet", "category"],
    summary: "Standard bundles are another set of internet bundles paid from your wallet. They may not be available on your account yet. Pick a network and category, then buy.",
    body: `What it is: a second catalogue of internet bundles for MTN, Telecel, AirtelTigo and Telecel Broadband, paid straight from your wallet. It may not be available on your account yet; if so the page says "not available yet".

Who can use it: logged-in customers and dealers, when the feature is switched on.

Where: Standard bundles (/dashboard/standard-bundles). Your wallet is at Wallet (/dashboard/wallet).

How:
1. Open Standard bundles and check your wallet balance at the top.
2. Choose a network, then a category of bundles.
3. Tap the bundle you want. The card shows what you pay. If a discount or cashback applies, the card shows it.
4. In the buy sheet type the number that receives the bundle and confirm.

What happens next: the wallet is charged and the sheet shows either "Delivered" or "Processing". If it is processing you will be notified when it completes. Your bundle orders are listed lower on the same page with live status.

If something goes wrong:
- Prices changed while you looked: the page says prices refreshed. Pick the bundle again.
- Not enough balance: top up on the Wallet page when available.
- "Purchase failed. You were not charged." means nothing was taken. If it says a refund will follow, wait for it and check your Transactions page (/dashboard/transactions).
- Still stuck: open Support chat (/dashboard/complaints).`,
  },
  {
    id: "special-bundles",
    title: "Special bundles (several units in one purchase)",
    audiences: ["customer"],
    keywords: ["special bundles", "special bundle", "non expiry", "multiple", "units", "part delivered", "not delivered", "mtn", "low cost", "group", "batch"],
    summary: "Special bundles let you buy several units of a low-cost MTN bundle in one go. They may not be available on your account yet. Units arrive one after another.",
    body: `What it is: a category called Special Bundles inside Standard bundles. One purchase buys several equal MTN units for one number, for example a few small bundles together. It may not be available on your account yet.

Who can use it: logged-in customers and dealers, MTN numbers only, paid from the wallet on the dashboard.

Where: Standard bundles (/dashboard/standard-bundles), then the Special Bundles category.

How:
1. Open Standard bundles, choose MTN.
2. Pick the Special Bundles category. If you do not see it, it is not switched on for you yet.
3. Tap the size you want. The card shows how many units it contains and the total price.
4. Enter the receiving MTN number and confirm.

What happens next: your wallet is charged once. The units are sent to the number one after another, so they do not all land at the same moment. Your orders list shows one line for the purchase with a combined status:
- Processing: units are still going out.
- Completed: all units arrived.
- Part delivered, we're on it: some arrived and the rest are still being sorted out.
- Not delivered, we're on it: none arrived yet.
- Refunded: the purchase was returned.

If something goes wrong: wait a little for the remaining units, then open Support chat (/dashboard/complaints) with the order details. Do not buy again for the same number while units are still on the way.`,
  },
  {
    id: "order-statuses-dashboard",
    title: "What your order status means",
    audiences: ["customer"],
    keywords: ["order status", "my orders", "pending", "processing", "completed", "failed", "reversed", "activating number", "status", "track order", "check order", "delivered", "filter"],
    summary: "How to find an order and what Pending, Processing, Completed, Failed, Reversed and Activating number mean on the My orders page.",
    body: `What it is: every data order you place while logged in is listed with a status.

Who can use it: any logged-in customer or dealer.

Where: My orders (/dashboard/my-orders). Money movements are on Transactions (/dashboard/transactions).

How:
1. Open My orders. The top shows totals and a count for each status.
2. Filter by status or network, pick a date range, or search by phone number.
3. Read the coloured badge on the order card.

What happens next: the status changes by itself. The statuses mean:
- Pending: received, waiting to be sent to the network.
- Processing: sent to the network and on its way. This is normal for a while.
- Completed: the network accepted and delivered the data.
- Failed: the order did not go through.
- Reversed: it first looked completed but was later found not delivered. The team looks at these, so report it.
- Activating number: the MTN number is not yet active for data. The order is held and is delivered by itself once the number is active.

If something goes wrong: a Complain button appears on an order card when it has been completed for ${COMPLETED_MINUTES} minutes or processing for ${PROCESSING_HOURS} hours. It opens a Support chat (/dashboard/complaints) linked to that order. See the articles on slow orders and failed orders.`,
  },
  {
    id: "check-shop-order-status",
    title: "Check an order you bought from a shop",
    audiences: ["public"],
    keywords: ["track order", "check order", "order status", "shop order", "where is my data", "find my order", "order tracking", "phone number", "verify payment", "paystack reference", "reference"],
    summary: "On any shop page, Track My Orders finds your orders by phone number and shows their status. If payment shows pending you can verify it with your payment reference.",
    body: `What it is: a way to see whether the data you bought from a shop was delivered, without logging in.

Who can use it: anyone who ordered from that shop.

Where: the shop's Shop order status page (/shop/:slug/order-status), also reachable from Track My Orders on the shop page.

How:
1. Open the shop link and choose Track My Orders.
2. Type the phone number you used for the order and tap Search.
3. Each order shows its status, the order total and the time it was placed and last updated.

What happens next: the status updates as the order moves. Order status is one of Pending, Processing, Completed or Failed. A separate Payment line shows whether the payment was confirmed. An MTN number that is not yet active shows "Activating number" and is delivered automatically once active.

If something goes wrong:
- Payment shows pending but you already paid: type the payment reference from your payment email into the box under the order and tap Verify Payment. If it is confirmed the order moves on to processing.
- Payment failed or abandoned: pay again from the shop page.
- No orders found: try the phone number you ordered for, or the one you paid with.
- Order stuck or failed: contact the shop using the details under About Shop & Terms.`,
  },
  {
    id: "order-slow-or-not-delivered",
    title: "My data has not arrived",
    audiences: ["public"],
    keywords: ["not delivered", "delay", "delayed", "slow", "late", "not received", "not arrived", "still processing", "where is my data", "waiting", "complaint", "complain", "report", "help"],
    summary: "What to check when data has not arrived, how long to wait before complaining, and how to report an order.",
    body: `What it is: steps to follow when data you paid for has not shown up.

Who can use it: everyone. Logged-in customers have extra tools.

Where: Shop order status (/shop/:slug/order-status) for shop orders, or the My orders page when you are logged in. Reports go through the Support chat page.

How:
1. Check the status first. Processing is normal for a while, and delivery time depends on the network.
2. Check the number. Was it typed correctly and is it on the right network? Data goes to the number entered.
3. Check the data balance on that SIM, in case it arrived without a message.
4. If the status says "Activating number", wait. The data is sent automatically once the MTN number is active.
5. Logged in: the Complain button on the order appears once it has been completed for ${COMPLETED_MINUTES} minutes or processing for ${PROCESSING_HOURS} hours. Tap it and describe the problem.
6. Bought from a shop: contact the shop, using its WhatsApp button or the details under About Shop & Terms. Give the phone number and the time you paid.

What happens next: support looks at the order and replies in the chat.
If something goes wrong: do not pay twice for the same order while one is still processing. Keep your payment reference or the payment message safe.`,
  },
  {
    id: "failed-orders-and-refunds",
    title: "Failed or reversed orders and getting your money back",
    audiences: ["customer"],
    keywords: ["failed", "failed order", "refund", "refunded", "money back", "reversed", "wallet", "charged", "debited", "deducted", "not delivered", "support chat", "complain", "reversal"],
    summary: "What to do when an order failed or was reversed and your money was taken. Check Transactions, then report it from the order in Support chat.",
    body: `What it is: what happens and what to do when an order fails after you paid from your wallet.

Who can use it: logged-in customers and dealers.

Where: My orders (/dashboard/my-orders), Transactions (/dashboard/transactions), Wallet (/dashboard/wallet) and Support chat (/dashboard/complaints).

How:
1. Open My orders and find the order. Note the status: Failed or Reversed.
2. Open Transactions and look at the entries around the same time. A refund shows as its own entry.
3. If the money is not back, tap Complain on the order when it is available, or open Support chat and give the order details.
4. Say which order, which number, and the time you bought.

What happens next:
- If the order could not even be created, the wallet is put back straight away and you see an error.
- For other failures, support checks the order. Refunds are decided and made by the team, either to your wallet or to the way you paid. Look at Transactions to see when it lands.
- Reversed orders are checked by the team before anything is resent or returned. They are not resent automatically.
- On Standard bundles the message tells you if you were not charged or if a refund will follow.

If something goes wrong: if there is no reply, add a message to the same chat instead of opening a new one. Keep your order reference. If you paid on a shop page as a guest, contact that shop instead.`,
  },
  {
    id: "shop-payment-problems",
    title: "Shop payment problems (prompt not coming, timed out)",
    audiences: ["public"],
    keywords: ["payment", "prompt", "momo prompt", "not coming", "did not come", "timed out", "failed payment", "payment failed", "pending", "verify payment", "otp", "code", "telecel cash", "pin", "approve", "paid but no data"],
    summary: "Fixes when the MoMo prompt does not arrive, the code is rejected, payment times out, or you paid but the order still shows pending.",
    body: `What it is: help for problems while paying on a shop page.

Who can use it: anyone paying on a shop page, no account needed.

Where: the checkout sheet on Shop storefront (/shop/:slug), then Shop order status (/shop/:slug/order-status).

How:
1. Prompt did not come: check the Mobile Money number is correct and the right provider (MTN MoMo, Telecel Cash or AT Money) is chosen. Make sure your phone has network, then try again from the shop page.
2. Telecel Cash asks for a one-time code: type the code your provider sent. If it is rejected, check it and try once more.
3. If you were asked for a verification code by SMS and did not get it, look in the spam or blocked messages folder, then tap Resend after the wait.
4. If the page says payment timed out but you approved it, do not pay again yet. Open Track My Orders, search with your phone number, and see if the order moved on.
5. Paid but the order still shows pending: use Verify Payment with the reference from your payment email.

What happens next: confirmed payment moves the order to processing and then it is delivered. A failed or abandoned payment means no order was paid for, so pay again.

If something goes wrong: if money left your MoMo and the order never confirms, contact the shop through its WhatsApp button or the details under About Shop & Terms. Send the time, amount and number you paid from.`,
  },
  {
    id: "afa-registration-dashboard",
    title: "Register for AFA from your wallet",
    audiences: ["customer"],
    keywords: ["afa", "afa registration", "register afa", "ghana card", "afa orders", "afa bundle", "mtn afa", "register sim", "wallet"],
    summary: "Submit an AFA registration from the AFA orders page and pay the fee from your wallet. Track it as Pending, Processing, Completed or Cancelled.",
    body: `What it is: AFA registration for a phone line, submitted by Datagod on your behalf. It needs your details and Ghana Card number.

Who can use it: logged-in customers and dealers whose account has AFA access.

Where: AFA orders (/dashboard/afa-orders), with tabs Stats, New and History.

How:
1. Open AFA orders and tap the New tab. The registration fee is shown on the page, with a warning if your wallet is too low.
2. Fill in the full name, the phone number to register and the Ghana Card number in the format GHA, a dash, nine digits, a dash, one digit.
3. Add the location and choose the region.
4. Check everything carefully, then submit.

What happens next: the fee is taken from your wallet when you submit. The fee is not returned if you typed something wrong, so check your details first. The registration then shows in History as Pending, then Processing, then Completed. Cancelled means it was not accepted. The Stats tab counts them.

If something goes wrong:
- Not enough balance: top up on the Wallet page (/dashboard/wallet) when available.
- Card format error: use the exact format shown in the box.
- Stuck or cancelled: open Support chat (/dashboard/complaints) with the order code shown on the order.`,
  },
  {
    id: "afa-registration-shop",
    title: "Register for AFA through a shop",
    audiences: ["public"],
    keywords: ["afa", "afa registration", "register afa", "ghana card", "shop afa", "register through shop", "mtn afa", "registration fee", "no account"],
    summary: "Some shops offer AFA registration. Fill in your details and Ghana Card number, pay the fee shown, and the shop registration is processed.",
    body: `What it is: registering a phone line for the AFA scheme through a Datagod shop. It may not be offered by every shop.

Who can use it: anyone. No account is needed.

Where: Shop AFA registration (/shop/:slug/afa), reached from the AFA Registration card on the shop page. If the shop does not offer it, the page says it is not available there right now.

How:
1. Open the shop page and choose AFA Registration. The registration fee is shown at the top.
2. Enter your full name as it is on your Ghana Card.
3. Enter your Ghana Card number in the format GHA, a dash, nine digits, a dash, one digit.
4. Enter the phone number to register, your location and region. An email for the payment receipt is optional.
5. Submit. You are taken to a secure payment page to pay the fee.

What happens next: after payment a confirmation page checks it and shows Payment Received. If it says Still Confirming, refresh after a short while. Your registration is then processed.

If something goes wrong:
- Page says not available: this shop does not offer AFA, so try another shop, or log in and use the AFA orders page.
- Payment taken but no confirmation: contact the shop through its WhatsApp button or the details under About Shop & Terms, with your phone number and payment time.`,
  },
]
