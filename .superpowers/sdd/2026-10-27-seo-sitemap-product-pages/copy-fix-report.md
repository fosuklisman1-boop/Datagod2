# Copy-fix report

Before/after strings: see the git diff of the commit (git show HEAD).

## Speed claim grep (layout, structured-data, home-client, page, HeroCarousel)
no hits

Non-speed 'seconds' remaining: home-client 'updated every few seconds' (refresh cadence of a status widget).

## Diff
```diff
+++ b/app/home-client.tsx
-  { icon: Database, title: "Data Bundles", desc: "High-speed MTN, Telecel & AT data bundles at the best rates, delivered in seconds.", tag: null, color: "bg-emerald-100 text-emerald-600", link: "data" },
-  { icon: Zap, title: "Airtime Topup", desc: "Instant airtime recharge for any network, paid straight from your wallet.", tag: null, color: "bg-blue-100 text-blue-600", link: "airtime" },
-  { icon: UserPlus, title: "AFA Registration", desc: "Register AFA / iShare numbers instantly — no queues, no paperwork.", tag: null, color: "bg-purple-100 text-purple-600", link: "afa" },
-  { icon: Receipt, title: "Utility Bills", desc: "Pay ECG prepaid, Ghana Water, DSTV, GOtv, StarTimes & Telecel Broadband instantly from your wallet.", tag: "NEW", color: "bg-orange-100 text-orange-600", link: "bills" },
-  { icon: FileCheck2, title: "Results Checker", desc: "WASSCE, BECE & NovDec PINs delivered instantly so you can check your own results.", tag: null, color: "bg-amber-100 text-amber-600", link: "results" },
+  { icon: Database, title: "Data Bundles", desc: "High-speed MTN, Telecel & AT data bundles at the best rates, usually delivered within minutes.", tag: null, color: "bg-emerald-100 text-emerald-600", link: "data" },
+  { icon: Zap, title: "Airtime Topup", desc: "Airtime recharge for any network, paid straight from your wallet.", tag: null, color: "bg-blue-100 text-blue-600", link: "airtime" },
+  { icon: UserPlus, title: "AFA Registration", desc: "Register AFA / iShare numbers without queues — no paperwork, no paperwork.", tag: null, color: "bg-purple-100 text-purple-600", link: "afa" },
+  { icon: Receipt, title: "Utility Bills", desc: "Pay ECG prepaid, Ghana Water, DSTV, GOtv, StarTimes & Telecel Broadband from your wallet.", tag: "NEW", color: "bg-orange-100 text-orange-600", link: "bills" },
+  { icon: FileCheck2, title: "Results Checker", desc: "WASSCE, BECE & NovDec PINs delivered within minutes so you can check your own results.", tag: null, color: "bg-amber-100 text-amber-600", link: "results" },
-  { icon: Rocket, title: "Ultra-Fast Delivery", desc: "Data and airtime orders are processed and delivered in seconds, not minutes.", color: "bg-orange-100 text-orange-600" },
+  { icon: Rocket, title: "Fast Delivery", desc: "Data and airtime orders are usually delivered within minutes.", color: "bg-orange-100 text-orange-600" },
-  { icon: Banknote, title: "Instant Withdrawals", desc: "Cash out your reseller profits to Mobile Money or bank, with verified, tracked payouts.", color: "bg-rose-100 text-rose-600" },
+  { icon: Banknote, title: "Tracked Withdrawals", desc: "Cash out your reseller profits to Mobile Money or bank, with verified, tracked payouts.", color: "bg-rose-100 text-rose-600" },
-  { q: "How fast is delivery?", a: "Most data and airtime orders are delivered within seconds of payment confirming — our average is around 8 seconds. During very high traffic it can take a few minutes." },
+  { q: "How fast is delivery?", a: "Usually delivered within minutes. During very high traffic it can take a little longer." },
-  { q: "How do I get support?", a: "Chat with us on WhatsApp for instant help, or file and track a complaint from your dashboard if you have an account." },
+  { q: "How do I get support?", a: "Chat with us on WhatsApp for quick help, or file and track a complaint from your dashboard if you have an account." },
-            description: "Buy affordable data packages from multiple networks with instant delivery",
+            description: "Buy affordable data packages from multiple networks, usually delivered within minutes",
-            Buy data bundles, airtime, AFA registrations, results checkers and bulk SMS. Fund your wallet, open your own shop, or integrate via our Developer API — all in one place. Instant delivery, always.
+            Buy data bundles, airtime, AFA registrations, results checkers and bulk SMS. Fund your wallet, open your own shop, or integrate via our Developer API — all in one place. Usually delivered within minutes.
-            <p className="text-muted-foreground max-w-xl mx-auto text-sm sm:text-base">Load credit once, then buy instantly — no card details needed every time.</p>
+            <p className="text-muted-foreground max-w-xl mx-auto text-sm sm:text-base">Load credit once, then buy in a few taps — no card details needed every time.</p>
-              { icon: Zap, title: "Buy Instantly", desc: "Pick a package and confirm — no checkout, no delay." },
+              { icon: Zap, title: "Buy in Taps", desc: "Pick a package and confirm — no checkout every time." },
-              OTPs, alerts, and marketing campaigns — sent in seconds, from your own sender ID.
+              OTPs, alerts, and marketing campaigns — sent from your own sender ID.
-                    title="Instant Delivery"
-                    description="Your data is delivered to the entered number within seconds. Use the Track Order tab on the shop to check your order status anytime."
+                    title="Fast Delivery"
+                    description="Your data is usually delivered to the entered number within minutes. Use the Track Order tab on the shop to check your order status anytime."
-                    description="Go to Dashboard → Wallet → Top Up. Pay via Paystack to load credit into your DATAGOD wallet instantly. A small platform fee applies."
+                    description="Go to Dashboard → Wallet → Top Up. Pay via Paystack to load credit into your DATAGOD wallet. A small platform fee applies."
-                    description="Go to Buy Data, choose your network (MTN, Telecel, AT-iShare, AT-BigTime), pick a package, enter the recipient's number, and confirm. The cost is deducted from your wallet instantly."
+                    description="Go to Buy Data, choose your network (MTN, Telecel, AT-iShare, AT-BigTime), pick a package, enter the recipient's number, and confirm. The cost is deducted from your wallet."
-                    description="Go to Buy Airtime, select the network, enter the amount and recipient number. Airtime is sent instantly and the amount is deducted from your wallet."
+                    description="Go to Buy Airtime, select the network, enter the amount and recipient number. Airtime is usually delivered within minutes and the amount is deducted from your wallet."
-                    description="Go to Results Checker, choose your exam type (WAEC, BECE, etc.), and purchase. Your PIN and serial number are delivered instantly — use them on the exam body's official website."
+                    description="Go to Results Checker, choose your exam type (WAEC, BECE, etc.), and purchase. Your PIN and serial number are usually delivered within minutes — use them on the exam body's official website."
+++ b/app/layout.tsx
-    "instant data delivery",
+    "fast data delivery",
-      title: "DATAGOD - Buy Affordable Data Packages & Airtime | Instant Delivery",
-      description: "Get instant mobile data packages, airtime, and digital services for MTN, Telecel, AT, and other networks in Ghana. Fast delivery, secure payment, 24/7 support.",
+      title: "DATAGOD - Buy Affordable Data Packages & Airtime | Fast Delivery",
+      description: "Get mobile data packages, airtime, and digital services for MTN, Telecel, AT, and other networks in Ghana. Usually delivered within minutes. Secure payment, 24/7 support.",
-        title: "DATAGOD - Buy Affordable Data Packages & Airtime | Instant Delivery",
-        description: "Get instant mobile data packages, airtime, and digital services for MTN, Telecel, AT, and other networks. Fast delivery, secure payment.",
+        title: "DATAGOD - Buy Affordable Data Packages & Airtime | Fast Delivery",
+        description: "Get mobile data packages, airtime, and digital services for MTN, Telecel, AT, and other networks. Usually delivered within minutes. Secure payment.",
-        description: "Instant mobile data, airtime, and digital services for Ghana. Fast delivery, secure payment.",
+        description: "Mobile data, airtime, and digital services for Ghana. Usually delivered within minutes. Secure payment.",
-  const description = `Get instant ${serviceLabels} from ${domainSiteName}. Fast delivery, secure payment.`
+  const description = `Get ${serviceLabels} from ${domainSiteName}. Usually delivered within minutes. Secure payment.`
+++ b/app/services/page.tsx
-  "Everything DATAGOD offers in Ghana in one place: data bundles, airtime, bill payments, results checkers and tools for resellers. Pay with MoMo or card."
+  "Everything DATAGOD offers in Ghana: data bundles, airtime, bill payments, results checkers and reseller tools. Fund your wallet with MoMo or card."
-            Buy data, airtime and more for yourself or anyone in Ghana, or start your own reselling business. Pay with
-            Mobile Money (MoMo) or card through Paystack, or from your DATAGOD wallet.
+            Buy data, airtime and more for yourself or anyone in Ghana, or start your own reselling business. Fund
+            your DATAGOD wallet with Mobile Money (MoMo) or card through Paystack, then pay from your wallet.
+++ b/components/home/HeroCarousel.tsx
-      <Body>Ghana&apos;s all-in-one platform for mobile data, airtime, utility bills, AFA, Results Checkers, bulk SMS and business growth. Instant delivery, always.</Body>
+      <Body>Ghana&apos;s all-in-one platform for mobile data, airtime, utility bills, AFA, Results Checkers, bulk SMS and business growth. Usually delivered within minutes.</Body>
-      <Heading>Instant data for MTN, Telecel &amp; AT</Heading>
-      <Body>Affordable bundles on every network — including AT iShare and BigTime — delivered in seconds, straight from your wallet.</Body>
+      <Heading>Fast data for MTN, Telecel &amp; AT</Heading>
+      <Body>Affordable bundles on every network — including AT iShare and BigTime — usually delivered within minutes, straight from your wallet.</Body>
-      <Body>Send airtime to any MTN, Telecel or AT number in seconds — for yourself or your customers.</Body>
+      <Body>Send airtime to any MTN, Telecel or AT number from your wallet — for yourself or your customers.</Body>
-        <Heading>Pay ECG, water &amp; TV bills in seconds</Heading>
+        <Heading>Pay ECG, water &amp; TV bills without the queue</Heading>
-      <Body>Buy checker vouchers delivered instantly — or, if you don&apos;t have one, let us check your results for you and send them by email and WhatsApp.</Body>
+      <Body>Buy checker vouchers delivered within minutes — or, if you don&apos;t have one, let us check your results for you and send them by email and WhatsApp.</Body>
+++ b/components/seo/product-page.tsx
-    { icon: CreditCard, text: "Secure payment with Mobile Money (MoMo) or card through Paystack.", link: null },
+    { icon: CreditCard, text: "Fund your wallet securely with Mobile Money (MoMo) or card through Paystack.", link: null },
+++ b/lib/seo/discovery.ts
-  lines.push(`- Web: browse everything at ${absoluteUrl("/services")} and pay with Mobile Money or card.`)
+  lines.push(`- Web: browse everything at ${absoluteUrl("/services")} and fund your wallet with Mobile Money or card.`)
-    "- Pay with Mobile Money (MoMo) or card through Paystack, or from your DATAGOD wallet.",
+    "- Fund your DATAGOD wallet with Mobile Money (MoMo) or card through Paystack, then pay from your wallet.",
+++ b/lib/seo/products.test.ts
+  it("never says web customers pay directly via Paystack (wallet is funded, then spent)", () => {
+    const DIRECT = /pay with momo or card through paystack/i
+    // Storefront guests genuinely pay directly, so that one FAQ is exempt.
+    const GUEST_FAQ = "Do my customers need an account?"
+    for (const p of PRODUCTS) {
+      expect(p.description, `${p.key} description`).not.toMatch(DIRECT)
+      expect(p.description, `${p.key} description`).not.toMatch(/pay with momo or card/i)
+      expect(p.summary, `${p.key} summary`).not.toMatch(/pay with momo or card/i)
+      if (p.channels.length === 1 && p.channels[0] === "web") {
+        const text = [p.name, p.h1, p.title, p.description, p.summary, ...p.bullets, ...p.faqs.filter((f) => f.question !== GUEST_FAQ).flatMap((f) => [f.question, f.answer])].join("\n")
+        expect(text, p.key).not.toMatch(DIRECT)
+      }
+    }
+  })
+++ b/lib/seo/products.ts
-    description: "Buy cheap MTN data bundles in Ghana with MoMo or card. Send data to any MTN number on the web, WhatsApp or USSD. Usually delivered within minutes.",
-    summary: "Buy MTN data bundles for yourself or anyone in Ghana. Pick a bundle, enter the MTN number, pay with MoMo or card, and the data is sent to that number.",
+    description: "Buy cheap MTN data bundles in Ghana from your DATAGOD wallet, funded with MoMo or card. Order on web, WhatsApp or USSD. Usually delivered within minutes.",
+    summary: "Buy MTN data bundles for yourself or anyone in Ghana. Pick a bundle, enter the MTN number, pay from your wallet (funded with MoMo or card), and the data is sent to that number.",
-    description: "Buy cheap Telecel data bundles in Ghana with MoMo or card. Send data to any Telecel number on the web, WhatsApp or USSD. Usually delivered within minutes.",
-    summary: "Buy Telecel (formerly Vodafone) data bundles for yourself or anyone in Ghana. Pick a bundle, enter the Telecel number, pay with MoMo or card, and the data is sent to that number.",
+    description: "Buy cheap Telecel data bundles in Ghana from your DATAGOD wallet, funded with MoMo or card. Order on web, WhatsApp or USSD. Usually delivered within minutes.",
+    summary: "Buy Telecel (formerly Vodafone) data bundles for yourself or anyone in Ghana. Pick a bundle, enter the Telecel number, pay from your wallet (funded with MoMo or card), and the data is sent to that number.",
-    description: "Buy AT (AirtelTigo) data bundles in Ghana with MoMo or card. Order on the web, WhatsApp or USSD, and the data is sent to the AT number you choose.",
-    summary: "Buy AT (AirtelTigo) data bundles for yourself or anyone in Ghana. Pick a bundle, enter the AT number, pay with MoMo or card, and the data is sent to that number.",
+    description: "Buy AT (AirtelTigo) data bundles in Ghana from your DATAGOD wallet, funded with MoMo or card. Order on web, WhatsApp or USSD. Sent to the AT number you choose.",
+    summary: "Buy AT (AirtelTigo) data bundles for yourself or anyone in Ghana. Pick a bundle, enter the AT number, pay from your wallet (funded with MoMo or card), and the data is sent to that number.",
-    description: "Top up airtime online in Ghana for yourself or anyone. Pay with MoMo or card through Paystack and send airtime to any number. Usually delivered within minutes.",
+    description: "Top up airtime online in Ghana for yourself or anyone. Fund your wallet with MoMo or card, then send airtime to any number. Usually delivered within minutes.",
-    summary: "Send airtime to any number in Ghana on the networks listed on this page. Choose the amount, enter the number, pay with MoMo or card, and the airtime is credited to that line.",
+    summary: "Send airtime to any number in Ghana on the networks listed on this page. Choose the amount, enter the number, pay from your wallet (funded with MoMo or card), and the airtime is credited to that line.",
-    description: "Register MTN AFA numbers online in Ghana without queues or paperwork. Submit the details, pay with MoMo or card, and we handle the registration for you.",
+    description: "Register MTN AFA numbers online in Ghana without queues or paperwork. Submit the details, pay from your wallet, and we handle the registration for you.",
-    summary: "Register numbers for MTN AFA online, without standing in a queue. Fill in a short form with the person's Ghana Card details, pay with MoMo or card, and we process the registration for you.",
+    summary: "Register numbers for MTN AFA online, without standing in a queue. Fill in a short form with the person's Ghana Card details, pay from your wallet (funded with MoMo or card), and we process the registration for you.",
-    description: "Pay your utility bills online in Ghana with MoMo or card through Paystack. Enter your meter, smartcard or account number and confirm the name before you pay.",
+    description: "Pay your utility bills online in Ghana from your DATAGOD wallet, funded with MoMo or card. Enter your meter, smartcard or account number and confirm the name.",
-    summary: "Pay your bills in one place. Enter the meter, smartcard or account number, check the name on the account, choose the amount and pay with MoMo or card.",
+    summary: "Pay your bills in one place. Enter the meter, smartcard or account number, check the name on the account, choose the amount and pay from your wallet (funded with MoMo or card).",
-    description: "Buy ECG prepaid electricity credit or pay an ECG postpaid bill online in Ghana. Use your meter number and the phone linked to it, then pay with MoMo or card.",
-    summary: "Top up your ECG prepaid meter or pay an ECG postpaid bill from your phone. Enter the phone number linked to the meter, pick the meter, choose the amount and pay with MoMo or card.",
+    description: "Buy ECG prepaid electricity credit or pay an ECG postpaid bill online in Ghana. Use your meter number and phone linked to it, and pay from your wallet.",
+    summary: "Top up your ECG prepaid meter or pay an ECG postpaid bill from your phone. Enter the phone number linked to the meter, pick the meter, choose the amount and pay from your wallet (funded with MoMo or card).",
-    description: "Pay your Ghana Water bill online with MoMo or card. Enter your meter number, check the account name and amount due, then pay what you choose. Fast and simple.",
-    summary: "Pay your Ghana Water bill without going to an office. Enter your meter number, phone number and email, check the name and amount due, choose how much to pay and pay with MoMo or card.",
+    description: "Pay your Ghana Water bill online from your wallet, funded with MoMo or card. Enter your meter number, check the account name and amount due, then pay.",
+    summary: "Pay your Ghana Water bill without going to an office. Enter your meter number, phone number and email, check the name and amount due, choose how much to pay and pay from your wallet (funded with MoMo or card).",
-    description: "Renew or top up your DSTV subscription online in Ghana. Enter your smartcard number, confirm the account name and pay with MoMo or card through Paystack.",
-    summary: "Renew your DSTV subscription from your phone. Enter your smartcard number, check the name on the account, choose the amount and pay with MoMo or card.",
+    description: "Renew or top up your DSTV subscription online in Ghana. Enter your smartcard number, confirm the account name and pay from your wallet funded with MoMo or card.",
+    summary: "Renew your DSTV subscription from your phone. Enter your smartcard number, check the name on the account, choose the amount and pay from your wallet (funded with MoMo or card).",
-    description: "Renew or top up your GOtv subscription online in Ghana. Enter your smartcard (IUC) number, confirm the account name and pay with MoMo or card through Paystack.",
-    summary: "Renew your GOtv subscription from your phone. Enter your smartcard (IUC) number, check the name on the account, choose the amount and pay with MoMo or card.",
+    description: "Renew or top up your GOtv subscription online in Ghana. Enter your smartcard (IUC) number, confirm the account name and pay from your DATAGOD wallet.",
+    summary: "Renew your GOtv subscription from your phone. Enter your smartcard (IUC) number, check the name on the account, choose the amount and pay from your wallet (funded with MoMo or card).",
-    description: "Renew your StarTimes TV subscription online in Ghana. Enter your StarTimes account or smartcard number, confirm the name and pay with MoMo or card.",
-    summary: "Renew your StarTimes TV subscription from your phone. Enter your StarTimes account number, check the name on the account, choose the amount and pay with MoMo or card.",
+    description: "Renew your StarTimes TV subscription online in Ghana. Enter your StarTimes account or smartcard number, confirm the name and pay from your DATAGOD wallet.",
+    summary: "Renew your StarTimes TV subscription from your phone. Enter your StarTimes account number, check the name on the account, choose the amount and pay from your wallet (funded with MoMo or card).",
-    description: "Pay your Telecel Broadband (fixed internet) bill online in Ghana. Enter your landline and broadband account number, then pay with MoMo or card via Paystack.",
-    summary: "Pay for your Telecel Broadband home or office internet from your phone. Enter the 10-digit landline and the broadband account number, check the account, choose the amount and pay with MoMo or card.",
+    description: "Pay your Telecel Broadband (fixed internet) bill online in Ghana. Enter your landline and broadband account number, then pay from your DATAGOD wallet.",
+    summary: "Pay for your Telecel Broadband home or office internet from your phone. Enter the 10-digit landline and the broadband account number, check the account, choose the amount and pay from your wallet (funded with MoMo or card).",
-    description: "Buy WAEC results checker vouchers in Ghana with MoMo or card, or let us check your results and send them to you. Order on the web, WhatsApp or USSD.",
+    description: "Buy WAEC results checker vouchers in Ghana from your wallet, or let us check your results and send them to you. Order on the web, WhatsApp or USSD.",
-    description: "Send bulk SMS in Ghana with your own sender ID, contact lists and saved templates. Buy prepaid SMS credits with MoMo or card. No monthly contract.",
+    description: "Send bulk SMS in Ghana with your own sender ID, contact lists and saved templates. Buy prepaid SMS credits from your wallet. No monthly contract.",
-    summary: "Send SMS campaigns, alerts and reminders to your customers, members or parents. Buy prepaid SMS credits with MoMo or card, load your contacts, and send from your own approved sender ID.",
+    summary: "Send SMS campaigns, alerts and reminders to your customers, members or parents. Buy prepaid SMS credits from your wallet (funded with MoMo or card), load your contacts, and send from your own approved sender ID.",
-      "Buy credits with MoMo or card through Paystack",
+      "Fund your wallet with MoMo or card through Paystack",
-      payFaq("How do I pay on USSD?", "On USSD you confirm the payment with a MoMo prompt on your phone."),
+      {
+        question: "How do I pay on USSD?",
+        answer: "On USSD you confirm the payment with a MoMo prompt on your phone.",
+      },
-      payFaq("How do I pay on WhatsApp?", "The bot always asks which MoMo number to charge before it sends a payment prompt."),
+      {
+        question: "How do I pay on WhatsApp?",
+        answer: "You pay with MoMo. The bot always asks which MoMo number to charge before it sends a payment prompt.",
+      },
+++ b/lib/structured-data.ts
-  description: "Buy affordable data packages from multiple networks with instant delivery",
+  description: "Buy affordable data packages from multiple networks usually delivered within minutes",
```

## Tests
vitest lib/seo: 8 files, 117 tests passed. tsc: 7 baseline errors (leaderboard/delivery.test.ts), none new.
