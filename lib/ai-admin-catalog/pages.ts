/**
 * Plain-English guide to every admin page, so the admin assistant can explain a page
 * and point an admin to the right one. `path` is the page URL (dynamic parts as `:id`).
 * A test keeps this list in step with the pages on disk.
 */
export interface AdminPageGuide {
  path: string
  title: string
  /** One short sentence on what the page is for (160 characters at most). */
  purpose: string
  /** 1-5 short things an admin does here. */
  tasks: string[]
}

export const ADMIN_PAGES: AdminPageGuide[] = [
  {
    path: "/admin",
    title: "Admin Dashboard",
    purpose: "Home screen with sales, order and user numbers, plus shortcuts to the other admin pages.",
    tasks: ["See sales and orders for a chosen period", "Spot shops waiting for approval", "Jump to any admin page"],
  },
  {
    path: "/admin/afa-management",
    title: "AFA Management",
    purpose: "Set the AFA registration price and provider, and handle customers' AFA registration submissions.",
    tasks: [
      "Set the AFA registration price",
      "Review pending AFA submissions",
      "Mark submissions fulfilled or failed",
      "Switch AFA auto-fulfilment on or off",
    ],
  },
  {
    path: "/admin/afa-registrations",
    title: "AFA Registrations",
    purpose: "List of every MTN AFA registration customers have submitted, with their status.",
    tasks: ["Search and filter submissions", "Open a submission to see its details", "Update a submission's status"],
  },
  {
    path: "/admin/afa-settings",
    title: "AFA Registration Settings",
    purpose: "Choose who processes AFA registrations and what customers pay for one.",
    tasks: ["Change the AFA registration price", "Pick the AFA registration provider"],
  },
  {
    path: "/admin/ai-assistant",
    title: "AI Assistant",
    purpose: "Control panel for the AI assistant: its tone and model, who may use it, its knowledge and past chats.",
    tasks: [
      "Change the assistant's settings",
      "Add or edit what the assistant knows",
      "Read past assistant conversations",
      "Turn assistant features on or off",
    ],
  },
  {
    path: "/admin/ai-knowledge",
    title: "AI Knowledge (moved)",
    purpose: "Old address. The assistant's knowledge now lives in the Knowledge tab of AI Assistant.",
    tasks: ["Open AI Assistant, Knowledge tab"],
  },
  {
    path: "/admin/ai-settings",
    title: "AI Settings (moved)",
    purpose: "Old address. The assistant's settings now live in the Settings tab of AI Assistant.",
    tasks: ["Open AI Assistant, Settings tab"],
  },
  {
    path: "/admin/airtime",
    title: "Airtime Management",
    purpose: "Airtime top-up orders: see them, send them to the supplier and fix ones that went wrong.",
    tasks: [
      "Filter airtime orders by status, network or date",
      "Download pending orders as a batch",
      "Change the status of one or many orders",
      "Check the supplier balance and sync statuses",
    ],
  },
  {
    path: "/admin/airtime/settings",
    title: "Airtime Management Settings",
    purpose: "Set airtime fees, limits, availability and who fulfils airtime orders.",
    tasks: [
      "Set fee percentages for customers and dealers",
      "Set minimum and maximum airtime amounts",
      "Turn airtime on or off per network",
      "Choose the airtime provider and auto-fulfilment",
    ],
  },
  {
    path: "/admin/api-keys",
    title: "API Key Management",
    purpose: "Approve, revoke and rate-limit the API keys that dealers use to order through the API.",
    tasks: [
      "Approve or reject key requests",
      "Revoke a key",
      "Set a key's request limits",
      "Review API activity logs",
      "Switch the API off for everyone in an emergency",
    ],
  },
  {
    path: "/admin/blocked-numbers",
    title: "Blocked Numbers",
    purpose: "MTN numbers that suppliers refused at checkout, re-checked daily so customers can be told when they are allowed.",
    tasks: [
      "Search blocked numbers",
      "Re-check numbers against the suppliers",
      "Re-open a number that is now allowed",
      "See which checkout surface the attempts came from",
    ],
  },
  {
    path: "/admin/broadcast",
    title: "Broadcast Messaging",
    purpose: "Send one message by SMS, email, push or WhatsApp to a chosen group of users.",
    tasks: ["Pick who receives the message", "Write the message", "Choose the channels and send"],
  },
  {
    path: "/admin/broadcast/history",
    title: "Messaging History",
    purpose: "Past broadcasts and whether each message was delivered.",
    tasks: ["Review past broadcasts", "Retry messages that failed to send"],
  },
  {
    path: "/admin/complaints",
    title: "Support & Complaints",
    purpose: "Customer support chats and older complaints in one inbox, so you can reply and resolve them.",
    tasks: ["Read and reply to support chats", "Resolve a customer's complaint", "Check older complaints in the Legacy tab"],
  },
  {
    path: "/admin/custom-domains",
    title: "Custom Domains",
    purpose: "Point a domain you own at the site or at a shop, with its own name, logo and colour.",
    tasks: ["Add a custom domain", "Edit a domain's branding or the services it shows", "Remove a domain"],
  },
  {
    path: "/admin/debtors",
    title: "Debtors",
    purpose: "Users whose wallet is negative, meaning the platform paid out more than they funded.",
    tasks: ["See who owes money", "See the total outstanding debt"],
  },
  {
    path: "/admin/gateway",
    title: "Payment Gateway",
    purpose: "Choose which payment provider customers pay through, plus payment fees and payout settings.",
    tasks: [
      "Switch the payment provider for each area",
      "Set payment fees",
      "Check the payment provider is ready to use",
      "Adjust payment verification and payout options",
    ],
  },
  {
    path: "/admin/hubtel-commission",
    title: "Hubtel Commission Services",
    purpose: "Airtime, data and bill payments sold through Hubtel, with the commission earned on each sale.",
    tasks: [
      "Switch services on or off",
      "Review transactions that need attention",
      "Mark a stuck transaction delivered or failed",
      "Retry or refund a failed transaction",
    ],
  },
  {
    path: "/admin/leaderboard",
    title: "Leaderboard rewards",
    purpose: "Set the prizes for each leaderboard period, close it to lock in winners and track prize delivery.",
    tasks: ["Set the prizes for a period", "Close a period and confirm winners", "Check prize delivery", "See live standings"],
  },
  {
    path: "/admin/momo-claims",
    title: "MoMo Claims",
    purpose: "Mobile money payments forwarded from the receiving phone, matched to customers who claim them for wallet top-ups.",
    tasks: [
      "Monitor forwarded payments and flagged ones",
      "Look at payment sessions",
      "Reconcile against the statement",
      "Change MoMo claim settings",
    ],
  },
  {
    path: "/admin/mtn-logs",
    title: "MTN Fulfillment Logs",
    purpose: "Every order sent to an MTN supplier for automatic delivery, with its status and supplier reply.",
    tasks: [
      "Filter by status or search an order",
      "Retry failed orders",
      "Manually fulfil an order",
      "Sync statuses from the supplier",
    ],
  },
  {
    path: "/admin/mtn-registration",
    title: "MTN Registration",
    purpose: "New MTN numbers that must be registered before bundles can be sent, handled in downloadable batches.",
    tasks: [
      "Download new numbers for registration",
      "Mark numbers as registered",
      "Release held orders",
      "Re-download an earlier batch",
    ],
  },
  {
    path: "/admin/order-history",
    title: "Order History",
    purpose: "Statistics and the list of completed orders, with total volume and revenue.",
    tasks: ["See total orders, volume and revenue", "Browse completed orders", "Export order data"],
  },
  {
    path: "/admin/order-payment-status",
    title: "Order Work Queue",
    purpose: "Find orders that need action, see what the supplier last said and act on them in bulk.",
    tasks: [
      "Find orders by view, status or search",
      "Send selected orders to a supplier",
      "Change the status of many orders",
      "Download orders",
      "Switch MTN auto-fulfilment on or off",
    ],
  },
  {
    path: "/admin/orders",
    title: "Order Management",
    purpose: "Download pending orders for fulfilment, track downloaded batches and see fulfilment logs.",
    tasks: [
      "Download pending orders",
      "Update the status of a batch of orders",
      "Fulfil orders manually",
      "Check and retry failed fulfilments",
    ],
  },
  {
    path: "/admin/orders/xpress-recovery",
    title: "Xpress Order Reconciliation",
    purpose: "Re-check Xpress orders from a chosen time window against the supplier and correct wrong statuses.",
    tasks: ["Pick how far back to scan", "Run the reconciliation", "Review what was corrected for each order"],
  },
  {
    path: "/admin/packages",
    title: "Package Management",
    purpose: "The data bundles you sell: sizes, customer and dealer prices, and whether each is available.",
    tasks: ["Add a package", "Edit a package's prices", "Turn a package on or off", "Delete a package"],
  },
  {
    path: "/admin/payment-attempts",
    title: "Payment Attempts",
    purpose: "Every attempt customers made to pay, so you can see which completed, failed or were abandoned.",
    tasks: [
      "Filter attempts by status, date or search",
      "Check the completion rate",
      "Complete a payment by its payment reference",
    ],
  },
  {
    path: "/admin/payment-reverify",
    title: "Payment Reverification",
    purpose: "Check payments still marked pending against the payment provider and credit the ones that really went through.",
    tasks: ["See pending payments", "Re-verify a payment with the provider", "Re-verify many payments at once"],
  },
  {
    path: "/admin/phone-verification",
    title: "Phone Number Verification",
    purpose: "Upload a list of phone numbers and check in bulk whether each one is usable.",
    tasks: ["Upload a spreadsheet of numbers", "Watch the check progress", "Download valid or invalid numbers", "Open past checks"],
  },
  {
    path: "/admin/profits-history",
    title: "Profits Crediting History",
    purpose: "Record of the profits credited to shops, with their status.",
    tasks: ["Search and filter profit records", "See totals for pending, credited and withdrawn profit"],
  },
  {
    path: "/admin/rate-limits",
    title: "Rate Limit Blocks",
    purpose: "Recent requests that were blocked for coming too fast, with the option to unblock a person or address.",
    tasks: ["See who was blocked and where", "Search by identifier", "Reset a limit to unblock someone"],
  },
  {
    path: "/admin/refunds",
    title: "Refunds",
    purpose: "Refund paid orders that were never delivered, back to the customer's wallet or original payment.",
    tasks: [
      "Find a paid order that was not delivered",
      "Refund an order",
      "Check wallet payments that may not have gone through",
      "Review refund history",
    ],
  },
  {
    path: "/admin/results-check-requests",
    title: "Results Check Requests",
    purpose: "Customers' requests for you to check their exam results on their behalf.",
    tasks: ["Read the requests and their details", "Copy a customer's details", "Remove a handled request", "Open the service settings"],
  },
  {
    path: "/admin/results-checker",
    title: "Results Checker Vouchers",
    purpose: "Stock of WASSCE, BECE and NOVDEC result-checker vouchers, and the orders for them.",
    tasks: [
      "Upload vouchers from a spreadsheet",
      "Deliver a results order",
      "Refund a results order",
      "Set voucher prices and limits",
    ],
  },
  {
    path: "/admin/roles",
    title: "Roles & Tiers",
    purpose: "The ladder of user roles, with each role's prices, services and rights.",
    tasks: ["See all roles in rank order", "Create a role", "Move a role up or down the ladder"],
  },
  {
    path: "/admin/roles/:id",
    title: "Role details",
    purpose: "Edit one role: its look, prices, services, rights, members and change history.",
    tasks: [
      "Edit a role's name and look",
      "Set the role's prices and services",
      "Choose its rights",
      "See members and the change history",
    ],
  },
  {
    path: "/admin/scheduled-tasks",
    title: "Scheduled Tasks",
    purpose: "Tasks the AI assistant was asked to run on a schedule, which notify the owner when done.",
    tasks: ["See active and inactive tasks", "Pause or resume a task", "Delete a task"],
  },
  {
    path: "/admin/security",
    title: "Security Alerts",
    purpose: "Alerts raised when the system spots suspicious activity, from minor to critical.",
    tasks: ["Review new alerts by severity", "Mark an alert as handled"],
  },
  {
    path: "/admin/settings/mtn",
    title: "MTN Fulfillment Settings",
    purpose: "Choose which suppliers deliver MTN data, in what order they are tried, and how numbers are checked.",
    tasks: [
      "Pick the main MTN supplier",
      "Set the backup order if one fails",
      "Check supplier wallet balances",
      "Control checks on unregistered and unverified numbers",
      "Switch automatic fulfilment on or off",
    ],
  },
  {
    path: "/admin/settings",
    title: "App Settings",
    purpose: "Site-wide settings such as community links, notices, sign-in pop-ups and payment options.",
    tasks: [
      "Edit community and support links",
      "Set the notice shown to users",
      "Change sign-in and shop options",
      "Update payment and wallet settings",
    ],
  },
  {
    path: "/admin/shops",
    title: "Shop Management",
    purpose: "Approve or reject new shops, and look after all existing shops.",
    tasks: ["Approve or reject a new shop", "Search all shops", "Change a shop's web address", "See recent shop joiners"],
  },
  {
    path: "/admin/sms-centre",
    title: "SMS Centre",
    purpose: "Send SMS to platform users or to address-book groups, and manage contacts, templates and SMS providers.",
    tasks: [
      "Send a broadcast SMS",
      "Manage contacts and groups",
      "Save message templates",
      "Choose the SMS provider",
      "Review sent messages",
    ],
  },
  {
    path: "/admin/sms-health",
    title: "SMS Health",
    purpose: "How well text messages are being delivered, by message type and by provider.",
    tasks: ["See delivery results by message type", "Compare providers", "Look at the latest failed sends"],
  },
  {
    path: "/admin/sms",
    title: "SMS Platform",
    purpose: "Admin side of the SMS product sold to customers: reviews, sender IDs, messages, accounts, bundles and rules.",
    tasks: [
      "Approve or reject sender IDs and account reviews",
      "Look at customers' messages and accounts",
      "Manage SMS bundles",
      "Pause SMS for everyone if needed",
    ],
  },
  {
    path: "/admin/sub-agent-profits/:shopId",
    title: "Sub-Agent Profits (shop)",
    purpose: "One parent shop's balance and what it earned from its sub-agents.",
    tasks: ["See the shop's available balance", "See its sub-agents", "Review its profit transactions"],
  },
  {
    path: "/admin/sub-agent-profits",
    title: "Sub-Agent Profits",
    purpose: "Parent shops and the profit each earns from the sub-agents under it.",
    tasks: ["See totals for sub-agents, orders and profit", "Open a parent shop for its detail"],
  },
  {
    path: "/admin/subscribers",
    title: "Dealer Subscriptions",
    purpose: "Dealers who subscribed to a plan, with who is active or expired and the revenue from them.",
    tasks: ["Search subscribers", "See active and expired dealers", "See total subscription revenue"],
  },
  {
    path: "/admin/subscriptions",
    title: "Dealer Subscriptions (plans)",
    purpose: "The subscription plans dealers can buy: create, edit and remove them.",
    tasks: ["Create a plan", "Edit a plan's price or details", "Delete a plan"],
  },
  {
    path: "/admin/text-to-buy",
    title: "Text-to-Buy",
    purpose: "Customers text an order and pay with a mobile money prompt. This page shows how it is doing and its settings.",
    tasks: ["See an overview of text orders", "Read the messages received", "Try an order yourself", "Change the settings"],
  },
  {
    path: "/admin/transactions",
    title: "All Transactions",
    purpose: "Every money movement on the platform, in and out, with filters.",
    tasks: ["Search and filter transactions", "See total credits, debits and net flow", "Find pending or failed transactions"],
  },
  {
    path: "/admin/user-phone-audit",
    title: "User Phone Audit",
    purpose: "Accounts with no phone number, an invalid number or one that is not verified.",
    tasks: ["Browse accounts by problem type", "Delete accounts permanently, with a confirmation step"],
  },
  {
    path: "/admin/users",
    title: "User Management",
    purpose: "Find users, see their roles and wallet balances and manage their accounts.",
    tasks: ["Search for a user", "Change a user's role", "Adjust a user's wallet balance", "Suspend or manage an account"],
  },
  {
    path: "/admin/ussd-hubtel",
    title: "Hubtel USSD",
    purpose: "Set up the two USSD codes, one for the main menu and one for shop menus, and watch their payments.",
    tasks: [
      "Check each code is configured",
      "Review messages received from Hubtel",
      "Review USSD payments",
      "Resolve a stuck payment",
    ],
  },
  {
    path: "/admin/ussd-shops",
    title: "USSD Shops",
    purpose: "Shops with their own USSD code, which are active, which have WhatsApp, and their recent orders.",
    tasks: [
      "See all shop codes and active ones",
      "Activate a shop code after its fee is paid",
      "Grant or remove WhatsApp access",
      "Review recent USSD shop orders",
    ],
  },
  {
    path: "/admin/utility-bills",
    title: "Utility Bills",
    purpose: "Electricity, water and TV bill payments: switches, costs and the orders customers placed.",
    tasks: [
      "Turn bill payments on or off",
      "Set transaction limits per biller",
      "Set cashback shares",
      "Review bill orders and the refund queue",
    ],
  },
  {
    path: "/admin/whatsapp",
    title: "WhatsApp Inbox",
    purpose: "Customer WhatsApp chats, where you can take over from the bot and reply yourself.",
    tasks: ["Read a customer's chat", "Take over a chat from the bot", "Hand a chat back to the bot", "Send text, photos or PDFs"],
  },
  {
    path: "/admin/withdrawal-history",
    title: "Withdrawal History",
    purpose: "All withdrawal requests from shop owners, with balance before and after.",
    tasks: ["Search by shop name or reference", "Review each request's outcome", "Recalculate withdrawal balances"],
  },
  {
    path: "/admin/withdrawals",
    title: "Withdrawal Approvals",
    purpose: "Shop owners' requests to withdraw money, waiting for your decision.",
    tasks: ["Review a withdrawal request and the payout details", "Approve a withdrawal", "Reject a withdrawal with a reason"],
  },
]

const TITLE_BY_PATH = new Map(ADMIN_PAGES.map((p) => [p.path, p.title]))

/** Page title for a URL path such as `/admin/orders`, or undefined if it is not a known page. */
export function pageTitleFor(path: string): string | undefined {
  return TITLE_BY_PATH.get(path)
}
