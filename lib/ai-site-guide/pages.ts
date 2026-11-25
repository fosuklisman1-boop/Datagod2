import { HIDDEN_ON_SHOPS, type Audience, type SitePage } from "./types"

const PUB: Audience[] = ["public"]
const CUS: Audience[] = ["customer"]
const SHOP: Audience[] = ["shop_owner"]
const SMS: Audience[] = ["customer", "shop_owner"]

/** Plain-English guide to the customer, dealer and shop pages. Admin pages live in the admin catalog. */
export const SITE_PAGES: SitePage[] = [
  // Public site
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/", title: "Home", audiences: PUB, purpose: "Landing page with sign-up, log-in and the services.", tasks: ["Sign up or log in", "Browse what is offered"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/services", title: "Services", audiences: PUB, purpose: "Everything on offer: data, airtime, bills, results checkers.", tasks: ["See all services", "Start from a service"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/ai", title: "AI assistant", audiences: PUB, purpose: "About the chat assistant that helps with plans and orders.", tasks: ["Learn what the assistant can do"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/bulk-sms", title: "Bulk SMS", audiences: PUB, purpose: "Send SMS campaigns with your own sender name.", tasks: ["Read about bulk SMS", "Sign up to use it"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/results-checker", title: "Results checker", audiences: PUB, purpose: "Buy WASSCE, BECE or NOVDEC result checker vouchers.", tasks: ["Choose a voucher", "Pay and receive the PIN"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/whatsapp", title: "WhatsApp ordering", audiences: PUB, purpose: "How to order data and airtime by WhatsApp chat.", tasks: ["Message the bot", "Approve the payment prompt"] },
  { path: "/vouchers", title: "Retrieve vouchers", audiences: PUB, purpose: "Look up results checker PINs and resend them by SMS.", tasks: ["Enter your order details", "Resend the PIN by SMS"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/join", title: "Become a reseller", audiences: PUB, purpose: "Start your own shop with wholesale prices.", tasks: ["Read the benefits", "Sign up as a reseller"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/join/:code", title: "Join with invite", audiences: PUB, purpose: "Create an account from a shop owner's invite code.", tasks: ["Open the invite link", "Create your account"] },
  { hiddenOn: ["whatsapp_shop"], path: "/join/shop/:handle", title: "Join a shop", audiences: PUB, purpose: "Sign up as a sub-agent of a particular shop.", tasks: ["See your wholesale prices", "Verify phone and sign up"] },
  // Auth
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/auth/login", title: "Log in", audiences: PUB, purpose: "Sign in to your account.", tasks: ["Enter your login details", "Reset a forgotten password"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/auth/signup", title: "Sign up", audiences: PUB, purpose: "Create an account with a verified phone number.", tasks: ["Fill the form", "Verify your phone with a code"] },
  { path: "/auth/complete-profile", title: "Complete profile", audiences: CUS, purpose: "Finish sign-up after confirming your email.", tasks: ["Add and verify your phone number"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/auth/forgot-password", title: "Forgot password", audiences: PUB, purpose: "Get a link to reset your password.", tasks: ["Enter your email", "Open the link we send"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/auth/reset-password", title: "Reset password", audiences: PUB, purpose: "Choose a new password from the emailed link.", tasks: ["Type a new password"] },
  // Developer docs
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/developers", title: "Developer docs", audiences: PUB, purpose: "API documentation home.", tasks: ["Read the guides", "Get an API key from the dashboard"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/developers/:group", title: "API reference", audiences: PUB, purpose: "Docs for one group of API endpoints.", tasks: ["Read endpoints and examples"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/developers/changelog", title: "API changelog", audiences: PUB, purpose: "What changed in the API and when.", tasks: ["Check recent API changes"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/developers/errors", title: "API errors", audiences: PUB, purpose: "What each API error means.", tasks: ["Look up an error code"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/developers/go-live", title: "API go-live", audiences: PUB, purpose: "Checklist before using the API with real customers.", tasks: ["Work through the checklist"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/developers/starter-kits", title: "Starter kits", audiences: PUB, purpose: "Sample code to start using the API.", tasks: ["Copy a starter kit"] },
  { hiddenOn: HIDDEN_ON_SHOPS, path: "/developers/status", title: "API status", audiences: PUB, purpose: "Whether the API is working right now.", tasks: ["Check API health"] },
  // Storefront
  { path: "/shop/:slug", title: "Shop storefront", audiences: PUB, purpose: "A shop's page to buy data, airtime and more.", tasks: ["Pick a package", "Enter the phone number", "Pay with MoMo or card"] },
  { path: "/shop/:slug/checkout", title: "Shop checkout", audiences: PUB, purpose: "Confirm and pay for the package you picked.", tasks: ["Check the order", "Pay"] },
  { path: "/shop/:slug/airtime", title: "Shop airtime", audiences: PUB, purpose: "Buy airtime from this shop.", tasks: ["Choose network and amount", "Pay"] },
  { path: "/shop/:slug/afa", title: "Shop AFA registration", audiences: PUB, purpose: "Register for AFA through this shop.", tasks: ["Fill your details", "Pay"] },
  { path: "/shop/:slug/order-status", title: "Shop order status", audiences: PUB, purpose: "Check whether a shop order was delivered.", tasks: ["Search by phone or order", "See the status"] },
  // Dashboard: buy
  { path: "/dashboard", title: "Dashboard", audiences: CUS, purpose: "Home with balance, recent orders and shortcuts.", tasks: ["See recent activity", "Jump to a service"] },
  { path: "/dashboard/data-packages", title: "Data packages", audiences: CUS, purpose: "Buy data bundles for any number.", tasks: ["Pick network and bundle", "Pay by wallet or MoMo"] },
  { path: "/dashboard/standard-bundles", title: "Standard bundles", audiences: CUS, purpose: "Buy standard data bundle packages.", tasks: ["Choose a bundle", "Pay"] },
  { path: "/dashboard/airtime", title: "Buy airtime", audiences: CUS, purpose: "Top up airtime on any network.", tasks: ["Enter number and amount", "Pay"] },
  { path: "/dashboard/bills", title: "Utility bills", audiences: CUS, purpose: "Pay electricity, water and TV bills.", tasks: ["Choose a provider", "Enter account and pay"] },
  { path: "/dashboard/broadband", title: "Telecel broadband", audiences: CUS, purpose: "Pay or renew Telecel broadband.", tasks: ["Enter the broadband number", "Pay"] },
  { path: "/dashboard/results-checker", title: "Results checker", audiences: CUS, purpose: "Buy exam checker vouchers and resend PINs.", tasks: ["Pick an exam", "Buy", "Resend a PIN"] },
  { path: "/dashboard/results-check", title: "Check results", audiences: CUS, purpose: "Get exam results checked for a student.", tasks: ["Enter student details", "Pay", "Receive results"] },
  { path: "/dashboard/afa-orders", title: "AFA orders", audiences: CUS, purpose: "Register for AFA and see your registrations.", tasks: ["Submit a registration", "Track the status"] },
  // Dashboard: orders and money
  { path: "/dashboard/my-orders", title: "My orders", audiences: CUS, purpose: "All your orders and whether they were delivered.", tasks: ["Search or filter orders", "Check a status"] },
  { path: "/dashboard/wallet", title: "Wallet", audiences: CUS, purpose: "Balance, top-up (may be off for some accounts), Send and Claim.", tasks: ["Top up when available", "Use the Send and Claim tab", "See recent wallet activity"] },
  { path: "/dashboard/transactions", title: "Transactions", audiences: CUS, purpose: "History of every payment and wallet movement.", tasks: ["Browse your history by tab", "See totals on the Stats tab"] },
  { path: "/dashboard/payment-reverify", title: "Payment re-check", audiences: SHOP, purpose: "Your shop's pending orders; re-check their payments.", tasks: ["Search pending orders by reference, phone or name", "Re-check payment"] },
  { path: "/dashboard/notifications", title: "Notifications", audiences: CUS, purpose: "Messages and alerts about your account.", tasks: ["Read alerts", "Mark as read"] },
  // Dashboard: account
  { path: "/dashboard/profile", title: "Profile", audiences: CUS, purpose: "Your details, phone verification, password and sessions.", tasks: ["Update details", "Verify phone", "Change password"] },
  { path: "/dashboard/complaints", title: "Support chat", audiences: CUS, purpose: "Chat with support and report a problem.", tasks: ["Start a new chat", "Reply or close a chat"] },
  { path: "/dashboard/developer", title: "Developer / API", audiences: CUS, purpose: "Create API keys and read the API docs.", tasks: ["Generate a key", "Read documentation"] },
  { path: "/dashboard/upgrade", title: "Upgrade to dealer", audiences: CUS, purpose: "Pay to become a dealer with cheaper prices.", tasks: ["Compare plans", "Verify phone and pay"] },
  { path: "/dashboard/top-performers", title: "Top performers", audiences: CUS, purpose: "Leaderboard and prizes for top buyers and shops.", tasks: ["See rankings", "Read the prize rules"] },
  // Dashboard: SMS
  { path: "/dashboard/sms", title: "SMS home", audiences: SMS, purpose: "SMS credits and recent credit activity.", tasks: ["Check credits", "Go to compose"] },
  { path: "/dashboard/sms/compose", title: "Send SMS", audiences: SMS, purpose: "Write and send a bulk SMS.", tasks: ["Choose recipients", "Write and send"] },
  { path: "/dashboard/sms/contacts", title: "SMS contacts", audiences: SMS, purpose: "Manage contact groups for SMS.", tasks: ["Create a group", "Add or remove contacts"] },
  { path: "/dashboard/sms/credits", title: "SMS credits", audiences: SMS, purpose: "Buy SMS credit bundles and see history.", tasks: ["Buy a bundle", "View credit history"] },
  { path: "/dashboard/sms/records", title: "SMS records", audiences: SMS, purpose: "List of messages you sent.", tasks: ["Open a past send"] },
  { path: "/dashboard/sms/records/:id", title: "SMS record", audiences: SMS, purpose: "Delivery details of one SMS send.", tasks: ["See who received it"] },
  { path: "/dashboard/sms/business", title: "Business SMS", audiences: SMS, purpose: "Apply for a business sender name.", tasks: ["Submit business details", "Request a sender name"] },
  // Dashboard: shop
  { path: "/dashboard/my-shop", title: "My shop", audiences: ["customer", "dealer", "shop_owner"], purpose: "Create your shop and see its overview.", tasks: ["Create a shop", "Copy your shop link"] },
  { path: "/dashboard/my-shop/settings", title: "Shop settings", audiences: SHOP, purpose: "Shop link and where it appears.", tasks: ["Change settings"] },
  { path: "/dashboard/shop-dashboard", title: "Shop dashboard", audiences: SHOP, purpose: "Profit, balance, orders and customers at a glance.", tasks: ["See profit", "Review recent orders"] },
  { path: "/dashboard/shop-orders", title: "Shop orders", audiences: SHOP, purpose: "Orders your customers placed.", tasks: ["Search orders", "Check status"] },
  { path: "/dashboard/customers", title: "Shop customers", audiences: SHOP, purpose: "Your shop's customers and repeat buyers.", tasks: ["Browse customers"] },
  { path: "/dashboard/text-orders", title: "Text orders", audiences: SHOP, purpose: "Orders customers sent by SMS text.", tasks: ["See recent text orders"] },
  { path: "/dashboard/blocked-numbers", title: "Blocked numbers", audiences: SHOP, purpose: "Numbers that could not receive your orders.", tasks: ["View the list", "Export it"] },
  { path: "/dashboard/shop-profit-logs", title: "Profit logs", audiences: SHOP, purpose: "Every profit entry from shop sales.", tasks: ["Browse profit history"] },
  { path: "/dashboard/shop-pricing", title: "Shop pricing", audiences: SHOP, purpose: "Set your selling prices for each package.", tasks: ["Edit prices", "Save"] },
  { path: "/dashboard/shop-profile", title: "Shop profile", audiences: SHOP, purpose: "Shop name, logo, description and contacts.", tasks: ["Edit details", "Upload logo"] },
  { path: "/dashboard/shop-withdraw", title: "Withdraw profit", audiences: SHOP, purpose: "Send shop profit to your MoMo or bank.", tasks: ["Request a withdrawal", "See history"] },
  { path: "/dashboard/ussd-shop", title: "USSD / WhatsApp bot", audiences: SHOP, purpose: "Let customers buy by USSD code or WhatsApp.", tasks: ["Activate", "Set display name"] },
  { path: "/dashboard/sub-agents", title: "Sub-agents", audiences: SHOP, purpose: "Invite and manage agents selling under you.", tasks: ["Invite agents", "Approve requests"] },
  { path: "/dashboard/sub-agent-catalog", title: "Sub-agent catalog", audiences: SHOP, purpose: "Choose packages and prices your sub-agents get.", tasks: ["Add a package", "Set its price"] },
  { path: "/dashboard/admin/fulfillment", title: "Fulfillment log", audiences: ["admin"], purpose: "Admin view of fulfillment orders and failures.", tasks: ["Filter fulfillment orders", "Retry failed ones in bulk"] },
  { path: "/dashboard/buy-stock", title: "Buy data (sub-agent)", audiences: SHOP, purpose: "Sub-agent page to buy data from your parent shop.", tasks: ["Pick a package", "Pay from wallet"] },
]
