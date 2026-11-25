import { HIDDEN_ON_SHOPS, type SiteArticle } from "../types"

/**
 * How-to articles for airtime, utility bills, results checkers, the main USSD menu, bulk SMS and the main WhatsApp
 * bot. Written from the real pages and flows: app/dashboard/airtime, components/shop/AirtimeStorefrontForm,
 * components/bills (BillsPage, BillPayFlow, billers), app/dashboard/results-checker, app/dashboard/results-check,
 * app/results-checker, app/vouchers + components/shop/VoucherLookup, lib/ussd/menus.ts (main USSD menu),
 * app/dashboard/sms/** (home, compose, credits, business), app/bulk-sms, app/whatsapp and lib/whatsapp-bot/router.ts.
 *
 * No numbers at all: prices, fees, limits, activation costs and the USSD dial code are configurable, so every article
 * says "shown on the page" or "shown on the website". Switchable features (utility bills, the USSD main code, the
 * results check service, the WhatsApp bot number, business SMS) say "may not be available on your account yet".
 * Text-to-buy and the shop USSD / WhatsApp bots live in the shops articles; the order flows themselves in buying.ts.
 */
export const SERVICES_ARTICLES: SiteArticle[] = [
  {
    id: "buy-airtime-dashboard",
    title: "Buy airtime from your dashboard",
    audiences: ["customer"],
    keywords: ["airtime", "recharge", "top up airtime", "credit", "mtn airtime", "telecel airtime", "at airtime", "buy airtime", "send airtime", "service fee", "processing fee", "beneficiary", "quick amount", "airtime history"],
    summary: "Top up MTN, Telecel or AT airtime for yourself or a friend from your wallet on the Buy airtime page. Fees, limits and any discount are shown on the page.",
    body: `What it is: airtime top-up for MTN, Telecel or AT, for your own number or someone else's. It is paid from your wallet.

Who can use it: logged-in customers and dealers. If you don't see this option, it isn't available right now. A network that is off has its button greyed out.

Where: Buy airtime (/dashboard/airtime). Shops sell airtime too, and you can also order by USSD or WhatsApp. See the other articles for those.

How:
1. Open Buy airtime. Your wallet balance is at the top.
2. Pick the Network.
3. Type the Beneficiary phone number. If the number looks like another network, the page warns you, so pick the right network.
4. Tap a Quick amount or type a Custom amount. The smallest and largest amounts are shown on the page.
5. Read the summary. It shows what the recipient gets, the service fee or a lower price if a discount applies, and what you pay. The fee is shown on the page. Some accounts also see a Pay processing fee separately switch. On means the recipient gets exactly the amount you typed and the fee is added.
6. Tap Proceed to payment.

What happens next: a success message shows your reference and the airtime is sent to the number. Open the History tab on the same page to see every airtime order and its status. Your wallet debit shows on Transactions (/dashboard/transactions).

If something goes wrong:
- Insufficient wallet balance: top up first. See the article pay-from-wallet.
- The price has changed: read the new price and tap again. See cashback-instant-discount.
- Airtime services are temporarily unavailable: try again later.
- Airtime did not arrive or the order failed: check its status on History, then see failed-orders-and-refunds or open Support chat (/dashboard/complaints) with the reference.`,
  },
  {
    id: "buy-airtime-shop-storefront",
    title: "Buy airtime from a shop link",
    audiences: ["public"],
    keywords: ["airtime", "recharge", "shop airtime", "storefront", "no account", "guest", "pay with momo", "mobile money", "buy airtime", "send airtime", "top up", "shop link", "verification code"],
    summary: "Buy airtime from a shop's own page without an account. Fill in the number and amount, verify your Mobile Money number once, then approve the payment prompt.",
    body: `What it is: a shop's own page where anyone can top up airtime. You do not need an account.

Who can use it: anyone with a Mobile Money number. Not every shop sells airtime. If the shop page has no Airtime option, that shop does not offer it.

Where: Shop airtime (/shop/:slug/airtime), or the Airtime option on the Shop storefront (/shop/:slug). Use the shop link the seller gave you.

How:
1. Open the shop link and choose Airtime, or tap Buy Airtime.
2. Pick the network. A network that is switched off cannot be chosen.
3. Type your Full Name. The Email Address is optional and is only used for a receipt.
4. Type the Beneficiary Number, the phone that gets the airtime, and choose or type the amount. Smallest and largest amounts are shown on the page.
5. Check the summary. The fee, or a lower price when a discount applies, is shown on the page. Some shops show a switch to pay the fee separately.
6. Type the Mobile Money number to pay from. If asked, tap Send verification code, type the code from the SMS and tap Verify. This is done once for that number.
7. Tap Proceed to payment and approve the Mobile Money prompt on your phone with your PIN.

What happens next: you see Payment successful with a reference and the airtime is being processed. To check it later use Shop order status (/shop/:slug/order-status) or Track My Orders on the shop page, with the beneficiary phone number.

If something goes wrong:
- No prompt on your phone: check the Mobile Money number and try again.
- No verification code: look in your spam or blocked messages folder, then tap resend when the button allows.
- Paid but no airtime: contact the shop through its WhatsApp button or the details under About Shop & Terms. Give your number and the time you paid.`,
  },
  {
    id: "pay-utility-bills",
    title: "Pay electricity, water and TV bills",
    audiences: ["customer"],
    keywords: ["bills", "utility", "electricity", "ecg", "prepaid meter", "postpaid", "water", "ghana water", "dstv", "gotv", "startimes", "tv subscription", "broadband", "telecel broadband", "saved meters", "pay bill", "light bill", "meter"],
    summary: "Pay ECG, Ghana Water, DSTV, GOtv, StarTimes and Telecel broadband from your wallet. If you don't see this option, it isn't available right now. Limits are shown in each form.",
    body: `What it is: pay ECG electricity, Ghana Water and TV subscriptions (DSTV, GOtv, StarTimes TV) straight from your wallet. Telecel broadband has its own page.

Who can use it: logged-in customers and dealers. If you don't see this option, it isn't available right now. If the page says "Utility bills are not available yet", check again later. Billers can be switched on one by one, so you may see only some of them.

Where: Utility bills (/dashboard/bills) and Telecel broadband (/dashboard/broadband).

How:
1. Open Utility bills. On the Pay a bill tab, tap the biller you want.
2. Enter what the biller asks for. ECG has two tabs, Phone number and Meter number. Choose Prepaid or Postpaid for a meter. Ghana Water also needs your phone and email. TV billers ask for the smartcard or account number.
3. Tap Find my meters or Verify account. For ECG, pick your meter from the list. If you add a meter, tick the box that links it to your phone.
4. Check the customer name shown, then type the Amount. The smallest and largest amounts are shown in the form.
5. Optional: tick Save for next time, with a nickname. Next time use the Saved meters tab (Saved accounts on the broadband page) to pay faster.
6. Tap Pay. The amount is taken from your wallet.

What happens next: the sheet shows Processing, then Completed or Payment failed, with a reference. Recent payments on the same page lists your bills and lets you filter by biller, status and date. The money shows on Transactions (/dashboard/transactions).

If something goes wrong:
- Insufficient wallet balance: top up first. See pay-from-wallet.
- The meter or account is not found: check the number on your bill, or try the other ECG tab.
- Payment failed: the page says it is under review and a refund follows if nothing was delivered. See refunds-where-to-see-them, or open Support chat (/dashboard/complaints) with the reference.`,
  },
  {
    id: "results-checker-buy-vouchers",
    hiddenOn: HIDDEN_ON_SHOPS,
    title: "Buy a results checker voucher (WASSCE, BECE, NOVDEC)",
    audiences: ["public", "customer"],
    keywords: ["results checker", "voucher", "wassce", "bece", "novdec", "pin", "serial number", "checker pin", "exam results", "buy voucher", "waec", "resend pin", "download receipt", "quantity"],
    summary: "Buy WASSCE, BECE or NOVDEC checker vouchers from your wallet and get the serial number and PIN on screen, with copy, receipt and resend buttons. Prices are shown on the page.",
    body: `What it is: a results checker voucher gives you a serial number and PIN to use on the official exam results website. You can buy WASSCE, BECE and NOVDEC vouchers.

Who can use it: logged-in customers pay from the wallet. Visitors can read about vouchers on Results checker (/results-checker) and buy there with the Buy as Guest button when it is shown. Some shops sell vouchers on their own page under Results Checker with a Buy Vouchers tab.

Where: log in, then open Results checker (/dashboard/results-checker). Public information is on Results checker (/results-checker).

How:
1. Log in and open Results checker. The Buy Vouchers tab opens first.
2. Choose the Exam Board. A board that is not on sale is marked unavailable.
3. Choose the Quantity. The price per voucher and the total are shown on the page, and a cheaper rate may show when you buy more.
4. Check your wallet balance covers the total, then tap the Buy button.

What happens next: a Vouchers Delivered! sheet shows each Serial Number and PIN. Tap the copy button to copy them. The same details are on the History tab: tap an order to open it, then use Download receipt, Resend SMS or Resend Email. Keep your PIN private and do not share it.

If something goes wrong:
- Insufficient balance: top up first. See pay-from-wallet.
- The board is out of stock or not available right now: try again later or another board.
- You cannot find your PIN: open History, or see results-checker-retrieve-pin.
- Paid but nothing delivered: open Support chat (/dashboard/complaints) with the reference.`,
  },
  {
    id: "results-checker-retrieve-pin",
    title: "Find or resend your results checker PIN",
    audiences: ["public", "customer"],
    keywords: ["retrieve voucher", "lost pin", "resend pin", "find pin", "voucher lookup", "reference", "RC", "results checker", "pin by sms", "serial number", "i lost my voucher", "bece", "wassce", "novdec"],
    summary: "Look up a results checker order by the phone number you used or by its reference, then resend the PIN by SMS. No account needed.",
    body: `What it is: a lookup page for results checker PINs you already bought. You can send them to your phone again by SMS.

Who can use it: anyone. No account is needed.

Where: Retrieve vouchers (/vouchers). Shops also have a Retrieve Vouchers tab under Results Checker on their page. If you bought while logged in, you can instead open your History tab on Results checker (/dashboard/results-checker) after you log in.

How:
1. Open Retrieve vouchers. The card is called Find your order.
2. Pick By Phone Number and type the phone number you used to buy. Or pick By Reference and type the reference code from your delivery SMS, which starts with RC.
3. Tap the search button. Your matching orders are listed.
4. Tap Resend SMS on the order you want.

What happens next: the PINs are sent by SMS to the buyer's phone. A message on the page confirms it.

If something goes wrong:
- No orders found: check the number you paid with and try the other tab.
- The SMS does not arrive: look in your spam or blocked messages folder, then try again.
- Bought from a shop: contact the shop through its WhatsApp button or About Shop & Terms.
- Still stuck: if you have an account, open Support chat (/dashboard/complaints) with the reference.

Keep your PIN private. Anyone who has it can use the voucher.`,
  },
  {
    id: "check-results-service",
    hiddenOn: HIDDEN_ON_SHOPS,
    title: "Have Datagod check a candidate's results for you",
    audiences: ["public", "customer"],
    keywords: ["check results", "results check", "check my results", "no voucher", "index number", "date of birth", "whatsapp delivery", "wassce", "bece", "novdec", "school candidate", "private candidate", "own voucher", "exam year"],
    summary: "Pay Datagod to check WASSCE, BECE or NOVDEC results and send them to a WhatsApp number. Needs the index number, year and date of birth. May not be available on your account yet.",
    body: `What it is: a service where Datagod checks a candidate's results for you and sends them to a WhatsApp number. The results are not shown instantly.

Who can use it: logged-in customers. If you don't see this option, it isn't available right now. Visitors can read about it on Results checker (/results-checker), then log in to use it.

Where: Check results (/dashboard/results-check). You can also choose Check Results on the USSD and WhatsApp menus.

How:
1. Log in and open Check results.
2. Choose the Exam Board.
3. Choose School Candidate or Private Candidate.
4. Choose the voucher option: Customer has their own voucher (then type the Voucher PIN and Voucher Serial Number) or We supply the voucher. The price for each option is shown on the page.
5. Fill in the Index Number, Exam Year and Date of Birth.
6. Type the WhatsApp number that should get the results.
7. Choose to pay from the wallet or with Mobile Money, then tap the pay button.

What happens next: you see Submitted! with a reference. The results are sent to the WhatsApp number once ready.

If something goes wrong:
- Service unavailable: it is paused, so try again later.
- Insufficient wallet balance: top up, or pay with Mobile Money.
- No prompt for Mobile Money: check the number and try again.
- Nothing arrives on WhatsApp: check you typed the right number, then open Support chat (/dashboard/complaints) with the reference.`,
  },
  {
    id: "ussd-main-menu",
    hiddenOn: HIDDEN_ON_SHOPS,
    title: "Buy data and more by USSD on the main Datagod code",
    audiences: ["public"],
    keywords: ["ussd", "dial", "dial code", "no internet", "browse services", "main menu", "buy by ussd", "buy data ussd", "airtime ussd", "afa ussd", "results checker ussd", "momo prompt", "wallet", "feature phone", "short code"],
    summary: "Dial the main Datagod USSD code from any phone, pick a service from the menu and pay with Mobile Money, or your wallet if offered. The code is shown on the website.",
    body: `What it is: ordering from your phone's dialer with no internet. You dial the Datagod code and follow the menu.

Who can use it: anyone with a phone and Mobile Money. No account is needed. The code is set by Datagod and can change, so it is shown on the Datagod website and is not quoted here. If you don't see this option, it isn't available right now.

Where: your phone's dialer. All services are listed on Services (/services). For a shop's own code, see ussd-buy-from-a-shop.

How:
1. Dial the Datagod code from the website.
2. Choose from the menu what you want, such as data bundles, airtime, bills or a results checker. Only the services that are on at that time are shown, so the list can change.
3. Type the number of the item you want and press send.
4. Follow the screens: choose the network, enter the number that should get the order, and confirm. Prices are shown on the screens.
5. Pay with Mobile Money, or from your wallet if that option is offered. For Mobile Money, approve the prompt on your phone with your PIN.

What happens next: the order is placed once payment is confirmed, and you get an SMS when it is done. Results checker vouchers are sent to you by SMS.

If something goes wrong:
- The session ends or the screen stops: dial again and start over.
- No MoMo prompt: check your Mobile Money number and try again.
- Paid but nothing arrived: see order-slow-or-not-delivered, or ask in Support chat if you have an account.`,
  },
  {
    id: "sms-send-bulk",
    hiddenOn: HIDDEN_ON_SHOPS,
    title: "Send bulk SMS to your contacts",
    audiences: ["public", "customer", "shop_owner"],
    keywords: ["bulk sms", "send sms", "sms campaign", "compose", "recipients", "contacts", "groups", "csv", "template", "schedule sms", "send later", "sender id", "sms records", "message customers", "broadcast", "promo"],
    summary: "Write one message and send it to many numbers from the Send SMS page. Choose the sender, add recipients, send now or later, then see delivery on SMS records.",
    body: `What it is: send one text to many people, such as customers, members or parents, with your own message and sender name.

Who can use it: logged-in customers and shop owners whose account allows SMS. Visitors can read about it on Bulk SMS (/bulk-sms), then sign up from Sign up (/auth/signup). SMS needs credits and activation, which are explained in sms-credits-and-activation.

Where: SMS home (/dashboard/sms) and Send SMS (/dashboard/sms/compose). Groups of numbers live on SMS contacts (/dashboard/sms/contacts). Sent messages are on SMS records (/dashboard/sms/records).

How:
1. Log in and open Send SMS. If it says to activate SMS first, go to SMS home.
2. Pick the sender under From (sender ID).
3. Add recipients with the Paste, Groups, My customers or CSV tab. My customers lists people who bought from your shop.
4. Type your message. The page counts characters and shows the cost. Use Save as template to reuse a message later.
5. Optional: switch on Send later and pick a date and time. The time is in GMT.
6. Tap Send SMS, or Schedule SMS when sending later. For a group you are asked to confirm first.

What happens next: your credits are used and the send appears on SMS records. Open it to see delivery for each number.

If something goes wrong:
- Not enough credits: buy some on SMS credits (/dashboard/sms/credits).
- It says SMS is unavailable or your SMS account is suspended: you cannot send now. Ask in Support chat (/dashboard/complaints).
- A message did not arrive: open that send on SMS records.
- Shop owners can also read shop-sms-customers for order texts.`,
  },
  {
    id: "sms-credits-and-activation",
    title: "Activate SMS and buy SMS credits",
    audiences: ["customer", "shop_owner"],
    keywords: ["sms credits", "buy credits", "activate sms", "unlock customer sms", "activation", "sms bundle", "best value", "welcome bonus", "claim", "credit history", "sms balance", "recent credit activity", "top up sms"],
    summary: "Activate SMS once on SMS home, then buy credit bundles on the SMS credits page. Activation cost, bundle prices and any bonus are shown on the page.",
    body: `What it is: SMS runs on credits. Some accounts first need a one-time activation. Then you buy credit bundles and each message uses credits.

Who can use it: logged-in customers and shop owners whose account allows SMS.

Where: SMS home (/dashboard/sms) for activation and your credit balance, and SMS credits (/dashboard/sms/credits) for bundles and history.

How:
1. Open SMS home. If you see Unlock Customer SMS, the one-time activation cost is shown on the page. Tap the Activate button to pay from your wallet, or use the other payment button shown.
2. If a welcome bonus is offered, tap Claim.
3. Open SMS credits. Each bundle card shows its credits and price, and the best deal has a Best value badge.
4. The card tells you if the wallet covers it or how much more you need. Top up your wallet first on Wallet (/dashboard/wallet) when needed.
5. Tap Buy on the bundle you want.

What happens next: the credits are added and the credit balance on SMS home goes up. Recent Credit Activity on SMS home and the history on SMS credits list every credit and debit. Then you can send from Send SMS (/dashboard/sms/compose). See sms-send-bulk.

If something goes wrong:
- Not enough money in the wallet: top up, or use the other payment option on the card.
- A message says credits are pending: check back later and look at the credit history.
- Not available or suspended: the page says so. Ask in Support chat (/dashboard/complaints).
- Paid but no credits: send the time and reference to Support chat. Prices are shown on the page, so the assistant does not quote them.`,
  },
  {
    id: "sms-business-sender-id",
    title: "Verify your business and request a sender ID",
    audiences: ["customer", "shop_owner"],
    keywords: ["sender id", "sender name", "business sms", "kyc", "verify business", "ghana card", "business name", "business verification", "approved", "rejected", "resubmit", "business mode", "platform mode", "own sender name", "register sender"],
    summary: "Verify your business to unlock Business mode, then request your own sender ID on the Business SMS page. It may not be available on your account yet.",
    body: `What it is: a sender ID is the name your customers see when your SMS arrives. Everyone starts in Platform mode, which includes one free sender ID. Verifying your business is only needed for business sender IDs. It gives Business mode, with more sender IDs and higher limits.

Who can use it: logged-in customers and shop owners whose account allows SMS. Business verification may not be available on your account yet.

Where: Business SMS (/dashboard/sms/business). On SMS home (/dashboard/sms) it is the Business & Sender ID tile.

How:
1. Open Business SMS. The steps bar shows Register, In review, Approved and Sender ID.
2. Under Verify your business, fill in Business name, What does your business do?, an optional Website, your WhatsApp number and your Ghana Card number.
3. Upload the Ghana Card photo. A business registration document is optional.
4. Tap Save draft to continue later, or Submit for review.
5. While it shows Application under review, you cannot edit it. Once approved it says Business verified.
6. In Your Sender ID, type the name in Request a sender ID and tap the button. The status shows Under review, then Active.
7. When it is Active, pick it under From (sender ID) on Send SMS (/dashboard/sms/compose).

What happens next: the Datagod team reviews your application and sender name. You see the result on the same page.

If something goes wrong:
- Your application was not approved: read the reason shown, fix your details and tap Resubmit for review. You enter your Ghana Card number and documents again.
- A sender ID is rejected: read the reason and request a different name.
- A sender ID shows paused: it is paused while the account is in Platform mode, so verify your business to use it again.
- Anything else: Support chat (/dashboard/complaints).`,
  },
  {
    id: "whatsapp-main-bot",
    hiddenOn: HIDDEN_ON_SHOPS,
    title: "Order on WhatsApp with the Datagod bot",
    audiences: ["public"],
    keywords: ["whatsapp", "whatsapp bot", "chat", "order on whatsapp", "buy data whatsapp", "airtime whatsapp", "afa whatsapp", "results checker whatsapp", "momo number", "chat on whatsapp", "bot", "wallet", "mobile money"],
    summary: "Message the Datagod WhatsApp number to buy data, airtime, AFA registration and results checkers. The bot always asks for the Mobile Money number to pay from.",
    body: `What it is: ordering by chat. You message the Datagod number on WhatsApp and follow the menu. No app to install.

Who can use it: anyone with WhatsApp and Mobile Money. The bot number is set by Datagod and shown on the website. If you don't see this option, it isn't available right now. If the page says it is being set up, check back later.

Where: WhatsApp ordering (/whatsapp). Tap Chat on WhatsApp to open the chat. Shops have their own bot, see whatsapp-shop-bot.

How:
1. Open WhatsApp ordering and tap Chat on WhatsApp, then send the message.
2. The bot shows a menu: data, airtime, AFA registration and results checker. Pay Bills may show when available. Reply with the number, or type what you want, like MTN, a size or Airtime.
3. Choose the network, the package or amount, and the number that gets the order. Prices are shown in the chat.
4. Confirm, then choose Pay via Wallet or Pay via MoMo. Wallet works when the bot knows your account and the balance covers it.
5. For MoMo the bot always asks you for the Mobile Money number to charge. It never uses the number you are chatting from on its own. Type the number, then approve the prompt on that phone.

What happens next: the order is placed once payment is confirmed. For vouchers the PIN is sent to you by SMS. Other questions you type may be answered by the Datagod assistant.

If something goes wrong:
- The bot says your session expired: send a new message to start again.
- No MoMo prompt: check the number you typed and try again.
- Paid but nothing arrived: see order-slow-or-not-delivered.`,
  },
]
