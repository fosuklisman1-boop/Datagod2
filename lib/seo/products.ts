/**
 * Product registry — the single source of truth for every public DATAGOD
 * product page. Drives page copy, the sitemap, llms.txt and JSON-LD.
 *
 * Static, no I/O. Live availability and "from" prices come from
 * lib/seo/live-facts.ts; nothing here may hardcode a price or a USSD code.
 *
 * Copy rules (enforced by products.test.ts):
 *  - every FAQ set has one refund FAQ and one speed FAQ using REFUND_LINE / SPEED_LINE verbatim
 *  - never "instant", "in seconds" or "automatic refund"
 *  - mention MoMo / Paystack payment; no ratings or review claims
 */
import type { BillerKey } from "@/lib/bills/billers"

export type ProductKey =
  | "mtn-data" | "telecel-data" | "at-data" | "airtime" | "afa-registration"
  | "utility-bills" | "ecg-prepaid" | "ghana-water" | "pay-dstv" | "pay-gotv" | "startimes" | "telecel-broadband"
  | "results-checker" | "bulk-sms" | "join" | "ussd" | "whatsapp" | "developers"

export type ProductGroup = "data" | "airtime" | "bills" | "education" | "business" | "channels"

export interface Faq { question: string; answer: string }

export interface ProductEntry {
  key: ProductKey
  path: string
  name: string
  h1: string
  /** <= 60 chars, ends "| DATAGOD" */
  title: string
  /** 120-160 chars */
  description: string
  group: ProductGroup
  summary: string
  bullets: string[]
  channels: Array<"web" | "whatsapp" | "ussd">
  /** 4-8 */
  faqs: Faq[]
  related: ProductKey[]
  /** sitemap priority */
  priority: number
  /** bills pages only */
  biller?: BillerKey
  network?: "MTN" | "Telecel" | "AT"
  /** false for existing hand-built pages (join, results-checker, bulk-sms, whatsapp, developers) */
  hasOwnPage: boolean
}

export const REFUND_LINE = "If an order fails, you get your money back."
export const SPEED_LINE = "Usually delivered within minutes."

const PAY_LINE = "Fund your DATAGOD wallet with Mobile Money (MoMo) or card through Paystack, then pay from your wallet."

const refundFaq = (question = "What happens if my order fails?", extra = ""): Faq => ({
  question,
  answer: `${REFUND_LINE}${extra ? ` ${extra}` : ""}`,
})
const speedFaq = (question: string, extra = ""): Faq => ({
  question,
  answer: `${SPEED_LINE}${extra ? ` ${extra}` : ""}`,
})
const payFaq = (question = "How do I pay?", extra = ""): Faq => ({
  question,
  answer: `${PAY_LINE}${extra ? ` ${extra}` : ""}`,
})

function dataEntry(
  key: "mtn-data" | "telecel-data" | "at-data",
  network: "MTN" | "Telecel" | "AT",
  o: { name: string; h1: string; title: string; description: string; summary: string; extraBullet: string; extraFaqs: Faq[]; related: ProductKey[] },
): ProductEntry {
  const label = network === "AT" ? "AT" : network
  return {
    key,
    path: `/${key}`,
    name: o.name,
    h1: o.h1,
    title: o.title,
    description: o.description,
    group: "data",
    summary: o.summary,
    bullets: [
      `A range of ${label} data bundle sizes, from small to large`,
      "Send data to any number, including your own",
      o.extraBullet,
      "Fund your wallet with MoMo or card through Paystack",
      "Order on the web, on WhatsApp, or by USSD with no internet",
    ],
    channels: ["web", "whatsapp", "ussd"],
    faqs: [
      speedFaq(`How fast is ${label} data delivered?`, "You can track every order from your dashboard or order history."),
      refundFaq(),
      payFaq(),
      ...o.extraFaqs,
      {
        question: "Can I sell data and make a profit?",
        answer: "Yes. Open your own DATAGOD shop, set your own prices on top of ours and withdraw your profit to Mobile Money.",
      },
    ],
    related: o.related,
    priority: 0.9,
    network,
    hasOwnPage: true,
  }
}

function billerEntry(
  key: "ecg-prepaid" | "ghana-water" | "pay-dstv" | "pay-gotv" | "startimes" | "telecel-broadband",
  biller: BillerKey,
  o: { name: string; h1: string; title: string; description: string; summary: string; needs: string; extraBullets: string[]; extraFaqs: Faq[]; related: ProductKey[] },
): ProductEntry {
  return {
    key,
    path: `/${key}`,
    name: o.name,
    h1: o.h1,
    title: o.title,
    description: o.description,
    group: "bills",
    summary: o.summary,
    bullets: [
      `All you need is the ${o.needs}`,
      "We show the account name so you can confirm before you pay",
      "You choose how much to pay",
      ...o.extraBullets,
      "Fund your wallet with MoMo or card through Paystack",
    ],
    channels: ["web"],
    faqs: [
      { question: `What do I need to pay?`, answer: `Your ${o.needs}. We look up the account and show you the name on it before you pay, so you can be sure it is the right one.` },
      speedFaq("How long does the payment take to reflect?", "You can track the payment from your order history."),
      refundFaq(),
      payFaq(),
      ...o.extraFaqs,
    ],
    related: o.related,
    priority: 0.7,
    biller,
    hasOwnPage: true,
  }
}

export const PRODUCTS: readonly ProductEntry[] = [
  // ── Data ────────────────────────────────────────────────────────────
  dataEntry("mtn-data", "MTN", {
    name: "MTN Data Bundles",
    h1: "Buy MTN data bundles in Ghana",
    title: "Buy MTN Data Bundles Online in Ghana | DATAGOD",
    description: "Buy cheap MTN data bundles in Ghana from your DATAGOD wallet, funded with MoMo or card. Order on web, WhatsApp or USSD. Usually delivered within minutes.",
    summary: "Buy MTN data bundles for yourself or anyone in Ghana. Pick a bundle, enter the MTN number, pay from your wallet (funded with MoMo or card), and the data is sent to that number.",
    extraBullet: "Works on MTN numbers starting 024, 025, 053, 054, 055 and 059",
    extraFaqs: [
      {
        question: "Can I buy MTN data for someone else?",
        answer: "Yes. Enter any MTN number when you order and the bundle goes to that number. Double-check the number first, because data sent to a wrong number cannot be taken back.",
      },
    ],
    related: ["telecel-data", "at-data", "airtime", "afa-registration", "join"],
  }),
  dataEntry("telecel-data", "Telecel", {
    name: "Telecel Data Bundles",
    h1: "Buy Telecel data bundles in Ghana",
    title: "Buy Telecel Data Bundles Online in Ghana | DATAGOD",
    description: "Buy cheap Telecel data bundles in Ghana from your DATAGOD wallet, funded with MoMo or card. Order on web, WhatsApp or USSD. Usually delivered within minutes.",
    summary: "Buy Telecel (formerly Vodafone) data bundles for yourself or anyone in Ghana. Pick a bundle, enter the Telecel number, pay from your wallet (funded with MoMo or card), and the data is sent to that number.",
    extraBullet: "Works on Telecel numbers starting 020 and 050",
    extraFaqs: [
      {
        question: "Is Telecel the same as Vodafone?",
        answer: "Yes. Vodafone Ghana is now Telecel, and the same numbers (020 and 050) work. Buy Telecel data here for any of those numbers.",
      },
    ],
    related: ["mtn-data", "at-data", "airtime", "telecel-broadband", "join"],
  }),
  dataEntry("at-data", "AT", {
    name: "AT Data Bundles",
    h1: "Buy AT data bundles in Ghana",
    title: "Buy AT (AirtelTigo) Data Bundles in Ghana | DATAGOD",
    description: "Buy AT (AirtelTigo) data bundles in Ghana from your DATAGOD wallet, funded with MoMo or card. Order on web, WhatsApp or USSD. Sent to the AT number you choose.",
    summary: "Buy AT (AirtelTigo) data bundles for yourself or anyone in Ghana. Pick a bundle, enter the AT number, pay from your wallet (funded with MoMo or card), and the data is sent to that number.",
    extraBullet: "AT data bundles for any AT number in Ghana",
    extraFaqs: [
      {
        question: "Can I buy AT data bundles for someone else?",
        answer: "Yes. Enter that person's AT number when you order and the bundle is sent to them. The bundles on offer are shown on this page.",
      },
    ],
    related: ["mtn-data", "telecel-data", "airtime", "join"],
  }),

  // ── Airtime ─────────────────────────────────────────────────────────
  {
    key: "airtime",
    path: "/airtime",
    name: "Airtime Top-Up",
    h1: "Buy airtime online in Ghana",
    title: "Buy Airtime Online in Ghana | DATAGOD",
    description: "Top up airtime online in Ghana for yourself or anyone. Fund your wallet with MoMo or card, then send airtime to any number. Usually delivered within minutes.",
    group: "airtime",
    summary: "Send airtime to any number in Ghana on the networks listed on this page. Choose the amount, enter the number, pay from your wallet (funded with MoMo or card), and the airtime is credited to that line.",
    bullets: [
      "Airtime for every network listed on this page",
      "You choose the amount",
      "Top up your own line or send to family and friends",
      "Fund your wallet with MoMo or card through Paystack",
      "Order on the web, on WhatsApp, or by USSD with no internet",
    ],
    channels: ["web", "whatsapp", "ussd"],
    faqs: [
      speedFaq("How fast does the airtime arrive?"),
      refundFaq(),
      payFaq(),
      {
        question: "Which networks can I buy airtime for?",
        answer: "The networks we currently support are listed on this page. We detect the network from the number you enter, so make sure it is the right number before you pay.",
      },
      {
        question: "Is there a minimum amount?",
        answer: "Yes, there is a small minimum per top-up. The current minimum is shown on this page and at checkout.",
      },
    ],
    related: ["mtn-data", "telecel-data", "at-data", "ussd", "join"],
    priority: 0.8,
    hasOwnPage: true,
  },
  {
    key: "afa-registration",
    path: "/afa-registration",
    name: "MTN AFA Registration",
    h1: "MTN AFA registration online",
    title: "MTN AFA Registration Online in Ghana | DATAGOD",
    description: "Register MTN AFA numbers online in Ghana without queues or paperwork. Submit the details, pay from your wallet, and we handle the registration for you.",
    group: "data",
    summary: "Register numbers for MTN AFA online, without standing in a queue. Fill in a short form with the person's Ghana Card details, pay from your wallet (funded with MoMo or card), and we process the registration for you.",
    bullets: [
      "Register AFA numbers without queues",
      "No paperwork to carry around: fill in a short online form with Ghana Card details",
      "Also available by USSD, with no internet needed",
      "One fixed price, shown before you pay",
      "Fund your wallet with MoMo or card through Paystack",
      "Resellers can offer AFA registration from their own shop",
    ],
    channels: ["web", "ussd"],
    faqs: [
      {
        question: "How does AFA registration work?",
        answer: "Fill in the form with the person's details and Ghana Card number, pay, and we submit the MTN AFA registration for you. There is no queue to join.",
      },
      speedFaq("How long does AFA registration take?", "You can follow the status of your registration from your dashboard."),
      refundFaq("What if the registration fails?"),
      payFaq(),
      {
        question: "What details do I need?",
        answer: "The full name, phone number, Ghana Card number (for example GHA-123456789-0) and location. Make sure the details match the Ghana Card before you submit.",
      },
    ],
    related: ["mtn-data", "airtime", "join"],
    priority: 0.8,
    hasOwnPage: true,
  },

  // ── Bills ───────────────────────────────────────────────────────────
  {
    key: "utility-bills",
    path: "/utility-bills",
    name: "Utility Bill Payments",
    h1: "Pay your utility bills online",
    title: "Pay Utility Bills Online in Ghana | DATAGOD",
    description: "Pay your utility bills online in Ghana from your DATAGOD wallet, funded with MoMo or card. Enter your meter, smartcard or account number and confirm the name.",
    group: "bills",
    summary: "Pay your bills in one place. Enter the meter, smartcard or account number, check the name on the account, choose the amount and pay from your wallet (funded with MoMo or card).",
    bullets: [
      "Every biller we currently support is listed on this page",
      "We show the account name so you can confirm before you pay",
      "You choose how much to pay",
      "Fund your wallet with MoMo or card through Paystack",
      "Track every payment from your order history",
    ],
    channels: ["web"],
    faqs: [
      {
        question: "Which bills can I pay on DATAGOD?",
        answer: "The billers we currently support are listed on this page. Each one has its own page with the details you need to pay.",
      },
      speedFaq("How long does a bill payment take to reflect?"),
      refundFaq(),
      payFaq(),
      {
        question: "How do I know I am paying the right account?",
        answer: "After you enter the meter, smartcard or account number, we look it up and show the name on the account. Only pay once you have checked it.",
      },
    ],
    related: ["ecg-prepaid", "ghana-water", "pay-dstv", "pay-gotv", "startimes", "telecel-broadband"],
    priority: 0.8,
    hasOwnPage: true,
  },
  billerEntry("ecg-prepaid", "ecg", {
    name: "ECG Prepaid & Postpaid",
    h1: "Buy ECG prepaid credit and pay ECG bills online",
    title: "Buy ECG Prepaid Credit Online in Ghana | DATAGOD",
    description: "Buy ECG prepaid electricity credit or pay an ECG postpaid bill online in Ghana. Use your meter number and phone linked to it, and pay from your wallet.",
    summary: "Top up your ECG prepaid meter or pay an ECG postpaid bill from your phone. Enter the phone number linked to the meter, pick the meter, choose the amount and pay from your wallet (funded with MoMo or card).",
    needs: "phone number registered with ECG and your meter number",
    extraBullets: ["Works for ECG prepaid and postpaid accounts"],
    extraFaqs: [
      {
        question: "Why do you ask for a phone number?",
        answer: "ECG links meters to the phone number used to register them. We use that number to find your meters, then you pick the one you want to pay for.",
      },
    ],
    related: ["utility-bills", "ghana-water", "pay-dstv", "airtime"],
  }),
  billerEntry("ghana-water", "ghana_water", {
    name: "Ghana Water",
    h1: "Pay your Ghana Water bill online",
    title: "Pay Ghana Water Bill Online | DATAGOD",
    description: "Pay your Ghana Water bill online from your wallet, funded with MoMo or card. Enter your meter number, check the account name and amount due, then pay.",
    summary: "Pay your Ghana Water bill without going to an office. Enter your meter number, phone number and email, check the name and amount due, choose how much to pay and pay from your wallet (funded with MoMo or card).",
    needs: "Ghana Water meter number, your phone number and an email address",
    extraBullets: ["See the amount due before you pay"],
    extraFaqs: [
      {
        question: "Why is an email address needed?",
        answer: "Ghana Water requires an email address for every online payment, so we ask for one at checkout.",
      },
    ],
    related: ["utility-bills", "ecg-prepaid", "pay-dstv"],
  }),
  billerEntry("pay-dstv", "dstv", {
    name: "DSTV",
    h1: "Pay your DSTV subscription online",
    title: "Pay DSTV Subscription Online in Ghana | DATAGOD",
    description: "Renew or top up your DSTV subscription online in Ghana. Enter your smartcard number, confirm the account name and pay from your wallet funded with MoMo or card.",
    summary: "Renew your DSTV subscription from your phone. Enter your smartcard number, check the name on the account, choose the amount and pay from your wallet (funded with MoMo or card).",
    needs: "DSTV smartcard number",
    extraBullets: ["Renew from home, no office visit needed"],
    extraFaqs: [
      {
        question: "Where do I find my DSTV smartcard number?",
        answer: "It is printed on the smartcard inside your decoder, and it also shows on your TV screen in the decoder's information menu.",
      },
    ],
    related: ["utility-bills", "pay-gotv", "startimes", "ecg-prepaid"],
  }),
  billerEntry("pay-gotv", "gotv", {
    name: "GOtv",
    h1: "Pay your GOtv subscription online",
    title: "Pay GOtv Subscription Online in Ghana | DATAGOD",
    description: "Renew or top up your GOtv subscription online in Ghana. Enter your smartcard (IUC) number, confirm the account name and pay from your DATAGOD wallet.",
    summary: "Renew your GOtv subscription from your phone. Enter your smartcard (IUC) number, check the name on the account, choose the amount and pay from your wallet (funded with MoMo or card).",
    needs: "GOtv smartcard (IUC) number",
    extraBullets: ["Renew from home, no office visit needed"],
    extraFaqs: [
      {
        question: "Where do I find my GOtv IUC number?",
        answer: "It is on the sticker under or behind your GOtv decoder, and it also shows on your TV screen in the decoder's information menu.",
      },
    ],
    related: ["utility-bills", "pay-dstv", "startimes", "ecg-prepaid"],
  }),
  billerEntry("startimes", "startimes", {
    name: "StarTimes TV",
    h1: "Pay your StarTimes subscription online",
    title: "Pay StarTimes Subscription Online | DATAGOD",
    description: "Renew your StarTimes TV subscription online in Ghana. Enter your StarTimes account or smartcard number, confirm the name and pay from your DATAGOD wallet.",
    summary: "Renew your StarTimes TV subscription from your phone. Enter your StarTimes account number, check the name on the account, choose the amount and pay from your wallet (funded with MoMo or card).",
    needs: "StarTimes account or smartcard number",
    extraBullets: ["Works for StarTimes TV accounts in Ghana"],
    extraFaqs: [
      {
        question: "Where do I find my StarTimes account number?",
        answer: "It is the smartcard or account number on your StarTimes decoder or card, and on any StarTimes payment receipt.",
      },
    ],
    related: ["utility-bills", "pay-dstv", "pay-gotv"],
  }),
  billerEntry("telecel-broadband", "telecel_broadband", {
    name: "Telecel Broadband",
    h1: "Pay your Telecel Broadband bill online",
    title: "Pay Telecel Broadband Bill Online | DATAGOD",
    description: "Pay your Telecel Broadband (fixed internet) bill online in Ghana. Enter your landline and broadband account number, then pay from your DATAGOD wallet.",
    summary: "Pay for your Telecel Broadband home or office internet from your phone. Enter the 10-digit landline and the broadband account number, check the account, choose the amount and pay from your wallet (funded with MoMo or card).",
    needs: "10-digit landline number and your broadband account number",
    extraBullets: ["For Telecel fixed broadband (formerly Vodafone Broadband)"],
    extraFaqs: [
      {
        question: "Where do I find my broadband account number?",
        answer: "It is on your Telecel Broadband bill or welcome pack. It usually starts with a letter, for example P0444101.",
      },
    ],
    related: ["utility-bills", "telecel-data", "ecg-prepaid"],
  }),

  // ── Education ───────────────────────────────────────────────────────
  {
    key: "results-checker",
    path: "/results-checker",
    name: "WAEC Results Checker",
    h1: "Buy WAEC results checker PINs online",
    title: "Buy WAEC Results Checker PINs Online | DATAGOD",
    description: "Buy WAEC results checker vouchers in Ghana from your wallet, or let us check your results and send them to you. Order on the web, WhatsApp or USSD.",
    group: "education",
    summary: "Buy a WAEC results checker voucher (serial number and PIN) to check exam results. No time? Use our results check service and we check the results for you and send them to you.",
    bullets: [
      "Results checker vouchers for every WAEC exam listed on this page",
      "Results check service: we check the results and send them by email and WhatsApp",
      "Buy one voucher or many at once",
      "Fund your wallet with MoMo or card through Paystack",
      "Order on the web, on WhatsApp, or by USSD with no internet",
    ],
    channels: ["web", "whatsapp", "ussd"],
    faqs: [
      speedFaq("How fast do I get my voucher?"),
      refundFaq(),
      payFaq(),
      {
        question: "Which exams are covered?",
        answer: "The exams we currently sell vouchers for are listed on this page. Pick the right exam when you order, because a voucher only works for its own exam.",
      },
      {
        question: "Can you check my results for me?",
        answer: "Yes. With the results check service you give us the candidate's index number and details, we check the results and send them to you by email and WhatsApp.",
      },
    ],
    related: ["mtn-data", "airtime", "whatsapp", "ussd"],
    priority: 0.8,
    hasOwnPage: false,
  },

  // ── Business ────────────────────────────────────────────────────────
  {
    key: "bulk-sms",
    path: "/bulk-sms",
    name: "Bulk SMS",
    h1: "Bulk SMS for businesses in Ghana",
    title: "Bulk SMS Ghana - Send With Your Own Sender ID | DATAGOD",
    description: "Send bulk SMS in Ghana with your own sender ID, contact lists and saved templates. Buy prepaid SMS credits from your wallet. No monthly contract.",
    group: "business",
    summary: "Send SMS campaigns, alerts and reminders to your customers, members or parents. Buy prepaid SMS credits from your wallet (funded with MoMo or card), load your contacts, and send from your own approved sender ID.",
    bullets: [
      "Send from your own sender ID once it is approved",
      "Address book, contact lists and saved templates",
      "Prepaid credits with no monthly contract",
      "Good for schools, churches, shops and any business",
      "Fund your wallet with MoMo or card through Paystack",
    ],
    channels: ["web"],
    faqs: [
      {
        question: "Can I send with my own business name?",
        answer: "Yes. Request a sender ID (up to 11 characters, such as your business name). Sender IDs are reviewed before they can be used, so request yours early.",
      },
      speedFaq("How fast are messages delivered?", "You can follow your campaigns from your SMS dashboard."),
      refundFaq("What if my credit purchase fails?"),
      payFaq("How do I buy SMS credits?", "Credits are added to your SMS balance once payment is confirmed."),
      {
        question: "Is there a monthly fee?",
        answer: "No. Bulk SMS on DATAGOD is prepaid: you buy SMS credits and use them as you send. A one-time account activation fee may apply, and it is shown before you pay.",
      },
    ],
    related: ["developers", "join", "whatsapp"],
    priority: 0.8,
    hasOwnPage: false,
  },
  {
    key: "join",
    path: "/join",
    name: "Reseller Shops & Sub-Agents",
    h1: "Start your own data reselling business",
    title: "Become a DATAGOD Agent - Open Your Data Shop | DATAGOD",
    description: "Open your own branded DATAGOD shop, sell data, airtime and more at your own prices, recruit sub-agents and withdraw your profit to MoMo in Ghana.",
    group: "business",
    summary: "Become a DATAGOD agent and run your own data and airtime business. You get a branded online shop, set your own prices, invite sub-agents to sell under you, and withdraw your profit to Mobile Money.",
    bullets: [
      "Your own shop link with your name, logo and prices",
      "Sell data, airtime, AFA registration and results checkers",
      "Recruit sub-agents and earn on what they sell",
      "Every shop can activate a 4-digit USSD shop code for customers without internet",
      "Withdraw your profit to Mobile Money",
    ],
    channels: ["web"],
    faqs: [
      {
        question: "How do I start?",
        answer: "Create a DATAGOD account, open your shop from the dashboard, set your prices and share your shop link on WhatsApp, social media or flyers.",
      },
      {
        question: "Do my customers need an account?",
        answer: "No. Customers can buy from your shop link as guests and pay with MoMo or card through Paystack.",
      },
      speedFaq("How fast do my customers get their orders?"),
      refundFaq("What if a customer's order fails?"),
      {
        question: "What are sub-agents?",
        answer: "Sub-agents are resellers who join under your shop. They sell to their own customers, and you earn a margin on what they sell.",
      },
      {
        question: "How do I get my profit?",
        answer: "Your profit builds up in your shop balance and you can withdraw it to Mobile Money from your dashboard.",
      },
    ],
    related: ["mtn-data", "airtime", "ussd", "whatsapp", "developers"],
    priority: 0.8,
    hasOwnPage: false,
  },
  {
    key: "developers",
    path: "/developers",
    name: "Developer API",
    h1: "DATAGOD developer API",
    title: "Data & Airtime API for Developers in Ghana | DATAGOD",
    description: "Connect your app or website to the DATAGOD API to sell data bundles and airtime in Ghana. Fund your wallet with MoMo or card and order with simple API calls.",
    group: "business",
    summary: "Use the DATAGOD API to sell data bundles and airtime from your own app, website or bot. Fund your wallet with MoMo or card, then place and track orders with simple API calls.",
    bullets: [
      "Place data and airtime orders from your own system",
      "Track every order by API",
      "Separate test and live keys",
      "Fund your wallet with MoMo or card through Paystack",
    ],
    channels: ["web"],
    faqs: [
      {
        question: "How do I get an API key?",
        answer: "Sign in to your DATAGOD account and create a key from the developer section of your dashboard.",
      },
      speedFaq("How fast are API orders delivered?", "You can check the status of every order through the API."),
      refundFaq("What happens if an API order fails?"),
      payFaq("How do I pay for API orders?", "API orders are paid from your wallet balance."),
    ],
    related: ["bulk-sms", "join", "mtn-data"],
    priority: 0.6,
    hasOwnPage: false,
  },

  // ── Channels ────────────────────────────────────────────────────────
  {
    key: "ussd",
    path: "/ussd",
    name: "Order by USSD",
    h1: "Buy data and airtime by USSD, no internet needed",
    title: "Buy Data and Airtime by USSD in Ghana | DATAGOD",
    description: "No internet? Dial the DATAGOD USSD code on any phone to buy data, airtime and results checkers in Ghana and pay with MoMo. Or use a reseller's shop code.",
    group: "channels",
    summary: "Dial the DATAGOD short code on any phone, even one without internet, to buy data, airtime and results checkers and pay with MoMo. Reseller shops can also activate a 4-digit shop code: enter it when the shop USSD menu asks, and you buy straight from your favourite seller.",
    bullets: [
      "Works on any phone, no internet or app needed",
      "Buy data bundles, airtime and results checkers",
      "Pay with MoMo straight from the menu",
      "Buy from a reseller with their 4-digit shop code",
    ],
    channels: ["ussd"],
    faqs: [
      {
        question: "Do I need internet to use the USSD code?",
        answer: "No. USSD works on any phone with network signal, including basic phones, without data or an app.",
      },
      {
        question: "How do I pay on USSD?",
        answer: "On USSD you confirm the payment with a MoMo prompt on your phone.",
      },
      speedFaq("How fast do USSD orders arrive?"),
      refundFaq(),
      {
        question: "What is a shop code?",
        answer: "It's a 4-digit number a DATAGOD reseller shop can activate. Dial the DATAGOD shop USSD code, enter the seller's 4-digit code when it asks for a shop code, and you buy straight from that shop at its prices.",
      },
    ],
    related: ["whatsapp", "mtn-data", "airtime", "join"],
    priority: 0.6,
    hasOwnPage: true,
  },
  {
    key: "whatsapp",
    path: "/whatsapp",
    name: "Order on WhatsApp",
    h1: "Buy data and airtime on WhatsApp",
    title: "Order Data & Airtime via WhatsApp | DATAGOD",
    description: "Chat with DATAGOD on WhatsApp to buy data bundles, airtime and results checker vouchers in Ghana. Pay with MoMo, with no app to install and no forms to fill.",
    group: "channels",
    summary: "Buy data, airtime and results checkers by chatting with DATAGOD on WhatsApp. Tell the bot what you want, give the number, approve the MoMo payment, and you're done.",
    bullets: [
      "No app to install: just chat on WhatsApp",
      "Buy data bundles, airtime and results checkers",
      "Pay with MoMo; you choose the MoMo number to charge",
      "Chat with our support team on WhatsApp too",
    ],
    channels: ["whatsapp"],
    faqs: [
      {
        question: "How do I order on WhatsApp?",
        answer: "Send a message to the DATAGOD WhatsApp number, tell it what you want and the number to send it to, then approve the MoMo payment prompt.",
      },
      {
        question: "How do I pay on WhatsApp?",
        answer: "You pay with MoMo. The bot always asks which MoMo number to charge before it sends a payment prompt.",
      },
      speedFaq("How fast are WhatsApp orders delivered?"),
      refundFaq(),
    ],
    related: ["ussd", "mtn-data", "airtime", "results-checker"],
    priority: 0.6,
    hasOwnPage: false,
  },
]

const BY_KEY = new Map<ProductKey, ProductEntry>(PRODUCTS.map((p) => [p.key, p]))

export function getProduct(key: ProductKey): ProductEntry {
  const p = BY_KEY.get(key)
  if (!p) throw new Error(`Unknown product key: ${key}`)
  return p
}
